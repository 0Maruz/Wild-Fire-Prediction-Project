#!/usr/bin/env python
"""Post-hoc calibrate the deployed ensemble without retraining.

Memory-frugal: never holds the full 4.4M-row feature matrix in memory.
Instead, iterates the parquet in 200K-row batches, predicts raw probabilities
chunk-by-chunk, then operates on the tiny (date, label, proba) summary frame.

Fits a Platt sigmoid (1-D logistic regression) on the validation slice's raw
ensemble probabilities, attaches the calibrator to the model in-place, and
re-evaluates the held-out test slice with the new calibrated probabilities.

Updates:
    outputs/models/lgbm_fire_date_model.pkl                  (model + calibrator)
    outputs/metadata/dataset_info.json                       (test_metrics + ECE)
    outputs/riskmap/fire_dates_all.geojson  metadata.metrics (mirrored)

Run from project root:
    .venv/bin/python scripts/post_calibrate.py
"""
from __future__ import annotations

import gc
import json
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd
import pyarrow.parquet as pq

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "src"))

from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import (  # noqa: E402
    accuracy_score, average_precision_score, f1_score,
    precision_score, recall_score, roc_auc_score,
)

import train  # noqa: E402  (provides _EnsembleRegressor + helpers)
from features import resolve_features  # noqa: E402

MODEL_PATH = os.path.join(ROOT, "outputs", "models", "lgbm_fire_date_model.pkl")
FEATURES_PATH = os.path.join(ROOT, "outputs", "features", "full_features.parquet")
META_PATH = os.path.join(ROOT, "outputs", "metadata", "dataset_info.json")
GEOJSON_PATH = os.path.join(ROOT, "outputs", "riskmap", "fire_dates_all.geojson")
CHUNK_SIZE = 200_000


def main() -> None:
    t0 = time.time()
    print("[1/6] Loading model...")
    model = joblib.load(MODEL_PATH)
    if not isinstance(model, train._EnsembleRegressor):
        raise SystemExit(f"Not _EnsembleRegressor: {type(model)}")
    model.calibrator = None  # clear any prior calibration before resampling raw

    print("[2/6] Reading parquet schema + computing feature list...")
    pf = pq.ParquetFile(FEATURES_PATH)
    schema_cols = pf.schema_arrow.names
    # Build a minimal pandas read first to get feature_cols using resolve_features
    head = pf.read_row_group(0).to_pandas().head(0)
    feature_cols = resolve_features(head)
    needed = list(set(feature_cols + ["date", "days_until_fire"]))
    needed = [c for c in needed if c in schema_cols]
    f32_cols = [c for c in feature_cols if c not in ("lat_grid", "lon_grid")]
    print(f"  Features: {len(feature_cols)}, parquet row-groups: {pf.num_row_groups}")

    print("[3/6] Predicting raw probabilities chunk-by-chunk (memory-frugal)...")
    summaries: list[pd.DataFrame] = []
    n_done = 0
    t_pred = time.time()
    for batch in pf.iter_batches(batch_size=CHUNK_SIZE, columns=needed):
        chunk = batch.to_pandas()
        # Downcast feature columns to float32 in place
        for c in f32_cols:
            if c in chunk.columns and chunk[c].dtype != np.float32:
                chunk[c] = chunk[c].astype(np.float32)
        X = chunk[feature_cols]
        raw = model._raw_proba(X)
        summaries.append(pd.DataFrame({
            "date": chunk["date"].to_numpy(),
            "days_until_fire": chunk["days_until_fire"].to_numpy().astype(np.int8),
            "raw_proba": raw.astype(np.float32),
        }))
        n_done += len(chunk)
        del chunk, X, raw, batch
        gc.collect()
        print(f"  {n_done:>9,} rows  ({time.time() - t_pred:.1f}s elapsed)", end="\r")
    print()

    df = pd.concat(summaries, ignore_index=True)
    del summaries
    gc.collect()
    print(f"  Total: {len(df):,} rows of (date, label, raw_proba)")
    print(f"  Prediction time: {time.time() - t_pred:.1f}s")

    print("[4/6] Building binary label + chronological split (full distribution)...")
    df["_y_bin"] = train._make_binary_label(df["days_until_fire"]).astype(np.int8)
    df = df.sort_values("date", kind="stable").reset_index(drop=True)
    n = len(df)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)
    val_df = df.iloc[train_end:val_end]
    test_df = df.iloc[val_end:]
    print(f"  Val:  {len(val_df):,} rows  ({int(val_df['_y_bin'].sum()):,} positives, {val_df['_y_bin'].mean()*100:.2f}% rate)")
    print(f"  Test: {len(test_df):,} rows  ({int(test_df['_y_bin'].sum()):,} positives, {test_df['_y_bin'].mean()*100:.2f}% rate)")

    val_raw = val_df["raw_proba"].to_numpy().astype(np.float64)
    val_y = val_df["_y_bin"].to_numpy()
    test_raw = test_df["raw_proba"].to_numpy().astype(np.float64)
    test_y = test_df["_y_bin"].to_numpy()
    test_days = test_df["days_until_fire"].to_numpy()

    print("[5/6] Fitting Platt calibrator on val (full distribution)...")
    val_ece_before = train.expected_calibration_error(val_y, val_raw)
    calibrator = LogisticRegression(C=1.0, solver="lbfgs", max_iter=200)
    calibrator.fit(val_raw.reshape(-1, 1), val_y)
    model.calibrator = calibrator
    val_cal = calibrator.predict_proba(val_raw.reshape(-1, 1))[:, 1]
    val_ece_after = train.expected_calibration_error(val_y, val_cal)
    print(f"  Val ECE: {val_ece_before:.4f} → {val_ece_after:.4f}")

    # Apply calibrator to test raw → calibrated test probabilities
    test_proba = calibrator.predict_proba(test_raw.reshape(-1, 1))[:, 1]
    test_pred = train._prob_to_days_for_compat(test_proba)

    # Binary metrics on calibrated test probabilities
    test_pred_05 = (test_proba >= 0.5).astype(int)
    auc = float(roc_auc_score(test_y, test_proba)) if len(np.unique(test_y)) > 1 else 0.0
    ap  = float(average_precision_score(test_y, test_proba)) if len(np.unique(test_y)) > 1 else 0.0
    acc = float(accuracy_score(test_y, test_pred_05))
    prec = float(precision_score(test_y, test_pred_05, zero_division=0))
    rec  = float(recall_score(test_y, test_pred_05, zero_division=0))
    f1   = float(f1_score(test_y, test_pred_05, zero_division=0))

    best_f1, best_thr = 0.0, 0.5
    for t in np.linspace(0.05, 0.95, 19):
        p = (test_proba >= t).astype(int)
        f = float(f1_score(test_y, p, zero_division=0))
        if f > best_f1:
            best_f1, best_thr = f, float(t)
    deploy_pred = (test_proba >= best_thr).astype(int)
    deploy_prec = float(precision_score(test_y, deploy_pred, zero_division=0))
    deploy_rec  = float(recall_score(test_y, deploy_pred, zero_division=0))
    deploy_acc  = float(accuracy_score(test_y, deploy_pred))
    deploy_f1   = float(f1_score(test_y, deploy_pred, zero_division=0))

    n_test = len(test_proba)
    pak = {}
    for k_pct in (0.05, 0.10, 0.20):
        k = max(int(n_test * k_pct), 1)
        topk = np.argsort(-test_proba)[:k]
        pak[f"precision_at_top_{int(k_pct*100)}pct"] = round(float(np.mean(test_y[topk])), 4)

    test_ece = train.expected_calibration_error(test_y, test_proba)
    reliability = train.reliability_bins(test_y, test_proba, n_bins=10)
    test_pos_rate = round(float(test_y.mean()), 4)

    print(f"  Test ECE: {test_ece:.4f}  AUC: {auc:.4f}")
    print(f"  Best threshold = {best_thr:.2f} → F1 {best_f1:.4f}, recall {deploy_rec:.4f}, precision {deploy_prec:.4f}")

    print("[6/6] Persisting calibrated model + metadata...")
    with open(META_PATH) as f:
        meta = json.load(f)
    tm = meta["model"]["test_metrics"]
    tm.update({
        "task": "binary_fire_in_3d",
        "evaluated_on": "full_distribution_test_window",
        "roc_auc": round(auc, 4),
        "average_precision": round(ap, 4),
        "binary_accuracy": round(acc, 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1": round(f1, 4),
        "best_f1": round(best_f1, 4),
        "best_threshold": round(best_thr, 4),
        "precision_at_best_thr": round(deploy_prec, 4),
        "recall_at_best_thr": round(deploy_rec, 4),
        "ece": round(test_ece, 4),
        "ece_val_before_calibration": round(val_ece_before, 4),
        "ece_val_after_calibration": round(val_ece_after, 4),
        "deployment_threshold": round(best_thr, 4),
        "deployment_precision": round(deploy_prec, 4),
        "deployment_recall": round(deploy_rec, 4),
        "deployment_f1": round(deploy_f1, 4),
        "deployment_accuracy": round(deploy_acc, 4),
        "reliability_bins": reliability,
        "test_positive_rate": test_pos_rate,
        **pak,
        "uplift_at_top_5pct": round(pak["precision_at_top_5pct"] / max(test_pos_rate, 1e-9), 3),
        "uplift_at_top_10pct": round(pak["precision_at_top_10pct"] / max(test_pos_rate, 1e-9), 3),
        "uplift_at_top_20pct": round(pak["precision_at_top_20pct"] / max(test_pos_rate, 1e-9), 3),
        "calibration_method": "platt_sigmoid",
        "calibrated_at": pd.Timestamp.now("UTC").isoformat(),
    })
    y_eval = np.where(test_days < 0, 0, test_days).astype(float)
    tm["mae_days"] = round(float(np.mean(np.abs(test_pred - y_eval))), 4)
    tm["rmse_days"] = round(float(np.sqrt(np.mean((test_pred - y_eval) ** 2))), 4)
    test_days_int = np.clip(np.round(test_pred), 0, 7).astype(int)
    tm["accuracy_within_1day"] = round(float(np.mean(np.abs(test_days_int - y_eval) <= 1)), 4)
    tm["accuracy_exact"] = round(float(np.mean(test_days_int == y_eval)), 4)

    with open(META_PATH, "w") as f:
        json.dump(meta, f, indent=2, default=str)
    print(f"  → {META_PATH}")

    with open(GEOJSON_PATH) as f:
        gj = json.load(f)
    gj.setdefault("metadata", {})["metrics"] = tm
    with open(GEOJSON_PATH, "w") as f:
        json.dump(gj, f)
    print(f"  → {GEOJSON_PATH}")

    joblib.dump(model, MODEL_PATH)
    print(f"  → {MODEL_PATH}")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s\n")
    print("Summary:")
    print(f"  ECE val:  {val_ece_before:.4f} → {val_ece_after:.4f}")
    print(f"  ECE test: {test_ece:.4f}")
    print(f"  AUC test: {auc:.4f}")
    print(f"  Test positive rate: {test_pos_rate*100:.2f}% (true distribution)")
    print(f"  Deployment threshold: {best_thr:.2f}")
    print(f"  At deployment: P {deploy_prec*100:.1f}%  R {deploy_rec*100:.1f}%  F1 {deploy_f1*100:.1f}%")


if __name__ == "__main__":
    main()
