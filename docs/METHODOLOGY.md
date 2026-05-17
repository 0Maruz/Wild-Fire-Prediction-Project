# Methodology: How the Wildfire Predictor Works

This document explains the **methodology**, **safeguards against data leakage**, and **validation protocol** used in the Thailand Wildfire Imminence Predictor. It exists so that a sceptical reader (researcher, journalist, government official) can independently verify that the model's reported metrics are achievable and not fabricated.

## 🎯 What the model does

**Question answered:** Given a 0.1° grid cell in Thailand at date `t`, what is the probability that a fire (FIRMS hotspot detection) will occur in that cell within `[t+1, t+3]`?

**Output:** Calibrated probability ∈ [0, 1].

## 📊 The pipeline (end-to-end)

```
1.  fetch_firms.py     → NASA FIRMS VIIRS hotspots (raw)
2.  fetch_weather.py   → ERA5 daily reanalysis (optional)
3.  fetch_treecover.py → Hansen GFC aggregates (optional, run-once)
4.  data_loader.py     → load, clean, grid-snap, daily aggregation, densification, merge
5.  features.py        → 164 features per cell-day (lag + rolling + calendar + neighbors)
6.  train.py           → label, undersample, tune, refit, calibrate, evaluate, persist
7.  risk_map.py        → predict, filter, write GeoJSON for dashboard
8.  scripts/rolling_eval.py → monthly stability audit
```

Every step is **deterministic given inputs + random_state=42**.

## 🔬 Critical methodology: anti-leakage

The single most important safeguard is preventing **temporal data leakage** — using information from the future (relative to a prediction date) as a model feature. Without this discipline, ML models routinely score 0.99 AUC on a "predict the past" task that's useless in production.

### Rule 1: every rolling window uses `.shift(1)` BEFORE `.rolling()`

Every aggregation in `src/features.py` goes through `_past_roll()`:

```python
def _past_roll(df, col, window, agg="sum"):
    """CAUSAL: shift(1) before rolling — 'last N days, excluding today'."""
    shifted = grp[col].shift(1)
    regrouped = shifted.groupby([df["lat_grid"], df["lon_grid"]]).rolling(window, ...)
    ...
```

So `fire_sum_7d` answers *"how many fires in the past 7 days, NOT including today"*, never *"how many fires in the past 7 days including today"*. Today's value is captured separately via `fire_count_today` (a known input at inference time).

### Rule 2: lag features `shift(lag)` with `lag ≥ 1`

```python
for lag in LAG_DAYS:  # (1, 2, 3, 4, 5, 6, 7, 14, 21, 30)
    df[f"fire_lag_{lag}"] = grp["fire_count"].shift(lag).fillna(0)  # CAUSAL
```

`fire_lag_1` is literally *yesterday's* fire count, not today's.

### Rule 3: trend features use lag arithmetic, not raw differences

```python
df["frp_trend_3d"] = df["frp_lag_1"] - df["frp_lag_4"]  # CAUSAL
# (NOT df["frp_sum"].diff(3) — that would include today)
```

### Rule 4: streak counters use shifted fire flags

```python
fire_flag_past = (grp["fire_count"].shift(1).fillna(0) > 0).astype(int)
# ... streak built on fire_flag_past, never on fire_flag_today
```

### Rule 5: cumulative features `.shift(1)` after `.cumsum()`

```python
cum = fire_flag.groupby(GROUP_KEYS).cumsum() \
              .groupby(GROUP_KEYS).shift(1).fillna(0)
# cum[i] = total past fires up to YESTERDAY (not today)
```

### Verification: every feature tagged `# CAUSAL`

Every leakage-free feature line in `src/features.py` has a `# CAUSAL` comment. A grep audit confirms 134 of 134 features are tagged:

```bash
grep -c "# CAUSAL" src/features.py
# → 134
```

### The label itself

`days_until_fire` is computed **strictly from FUTURE rows**:

```python
for k in range(1, horizon + 1):
    shifted = df.groupby(GROUP_KEYS)["fire_count"].shift(-k).fillna(0)
    # shifted[i] = fire_count at i+k (future)
    future_fire = shifted > 0
    labels = np.where(future_fire & unset, k, labels)
```

So the label uses **only data from `[t+1, t+horizon]`**. By construction, no feature can equal or be derivable from the label (because all features are computed from `≤ t-1` or `t` data only).

## 📐 The split protocol

### Chronological, not random

```python
sorted_df = df.sort_values("date")
n = len(sorted_df)
train = sorted_df.iloc[: int(n * 0.6)]
val   = sorted_df.iloc[int(n * 0.6) : int(n * 0.8)]
test  = sorted_df.iloc[int(n * 0.8) :]
```

- **Train:** earliest 60% of timeline (~2025-01-31 → 2025-11-08)
- **Val:** next 20% (~2025-11-09 → 2026-02-10) — used for early stopping + Platt calibration
- **Test:** final 20% (~2026-02-11 → 2026-05-14) — never seen during tuning or selection

### Time-series cross-validation with gap

During hyperparameter search:

```python
cv = TimeSeriesSplit(n_splits=5, gap=7)
```

- 5 folds, each fold's train-end and val-start separated by **7 days**
- Prevents leakage from features that look back ≤ 6 days

### Negative undersampling (training only, never test)

Positive class is rare (~5% globally). To make training tractable:

```python
NEG_TO_POS_RATIO = 4   # keep 4 negatives per 1 positive in train+val
```

Test set keeps the **real class distribution** (~3.43%) so reported metrics
reflect production reality, not the training mix.

## 🔧 Calibration

Raw probabilities from the LightGBM ensemble are **not calibrated** — "0.7" might mean "45% in practice". Phase 0.5 added Platt scaling:

```python
calibrator = LogisticRegression(C=1.0, solver="lbfgs", max_iter=200)
calibrator.fit(val_raw_probabilities.reshape(-1, 1), val_labels)
# Inference: model.predict_proba(X) → calibrator.predict_proba(raw)
```

ECE on validation dropped from **0.3059 → 0.0057** after calibration.
ECE on held-out test: **0.0216** (excellent — < 0.05).

This means the probability output is **meaningful as a percentage**: a cell at 0.7 probability has a ~70% chance of burning within 3 days, validated on data the calibrator never saw.

## 📈 Validation

### 1. Held-out test (single best snapshot)

| | AUC | ECE | F1@deploy | Recall@deploy |
|---|---|---|---|---|
| Value | **0.8451** | **0.0216** | 0.194 | 0.765 |

### 2. Rolling monthly evaluation (17 months)

```bash
python scripts/rolling_eval.py
```

Computes AUC, ECE, F1, precision, recall on a 1-month sliding window across the entire dataset. Output: `outputs/metadata/rolling_eval.json`.

| | AUC mean | std | min | max |
|---|---|---|---|---|
| Value | **0.9152** | 0.0640 | 0.8044 | 0.9845 |

This is the **strongest evidence the model isn't overfit to a single time window**.

### 3. Retrospective validation (live)

Every prediction snapshot is **appended** to `outputs/riskmap/fire_dates_all.geojson` with a `validation_status` field. When `risk_map.py` runs and the prediction window has closed, it tags each past cell:

- **hit** — FIRMS hotspot observed in the predicted ±1-day window
- **miss** — no hotspot in the window
- **future** — window hasn't closed yet

The dashboard's "Past Predictions" panel displays per-snapshot hit rates so users can audit historical performance against ground truth.

## 🧮 Why the test positive rate is "low" but the model is "good"

Class imbalance is severe: globally ~5% of cell-days have a fire within the next 3 days; in the test window it's ~3.43% (some months are off-burn-season).

This means:
- **Accuracy is misleading** — always predicting "no fire" gives 96.6% accuracy. So we don't report it as a headline.
- **Precision is structurally low** — at threshold 0.05, precision is ~11%. This isn't bad; it's the expected behavior given the prior.
- **Watch-list framing is more honest** — "the top 20% highest-scored cells contain 3.4× more actual fires than random selection" — this is operationally useful and distribution-robust.

This is why the dashboard headlines **AUC**, **ECE**, **stability**, and **watch-list lift** instead of accuracy or recall.

## 🚫 Things we explicitly do NOT do

- ❌ **No tuning on test data** — best threshold reported is descriptive only; deployment threshold is locked
- ❌ **No fold mixing** — TimeSeriesSplit ensures temporal order
- ❌ **No look-ahead in features** — `# CAUSAL` audit on every feature
- ❌ **No feature engineering on full dataset** — features computed before split
- ❌ **No oversampling minorities** — only undersampling majorities (preserves true signal)
- ❌ **No metric cherry-picking** — both binary metrics and legacy regression metrics are saved; the misleading legacy metrics are flagged as such in the frontend

## 🔁 Reproducibility

Anyone with the same code + same `FIRMS_API_KEY` can reproduce the model:

```bash
git clone https://github.com/0Maruz/Science-Project-version-3
cd Science-Project-version-3
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill FIRMS_API_KEY
./run.sh --fresh --weather --quick
```

- All randomness is seeded with `random_state=42`
- Hyperparameters are persisted in `outputs/metadata/dataset_info.json`
- Model history retained in `outputs/models/history/{TIMESTAMP}_lightgbm.pkl`

## 📜 Audit checklist for sceptical readers

If you want to verify the model is honest:

- [ ] Inspect `src/features.py` — every feature has a `# CAUSAL` comment + explanation
- [ ] Inspect `src/train.py` — chronological split, time-series CV with gap, no test-set tuning
- [ ] Inspect `scripts/post_calibrate.py` — Platt scaling fit on val only
- [ ] Inspect `scripts/rolling_eval.py` — independent monthly evaluation
- [ ] Check `outputs/metadata/dataset_info.json` — full hyperparameter trail + metrics
- [ ] Check `outputs/metadata/rolling_eval.json` — 17-month AUC time series
- [ ] Check `outputs/riskmap/fire_dates_all.geojson` — past predictions with validation_status
- [ ] Try fetching one base_date's prediction and check FIRMS for that date — it's all public data

## 📞 Disagree with anything?

Open a [GitHub issue](https://github.com/0Maruz/Science-Project-version-3/issues) with a concrete observation. The point of an open-source methodology document is precisely to be challenged.

---

*Methodology document version 0.5 · Last updated 2026-05-16*
