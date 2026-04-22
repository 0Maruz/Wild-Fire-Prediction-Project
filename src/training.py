# =========================================================
# FIRE DATE PREDICTION - TRAINING PIPELINE
# Predicts WHEN fire will occur (specific date within 7 days)
# =========================================================

import json
import joblib
import os
import glob
import numpy as np
import pandas as pd

from dotenv import load_dotenv
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error, mean_squared_error
from lightgbm import LGBMRegressor

# =========================================================
# 0) LOAD ENV & CONFIG
# =========================================================
load_dotenv()

GRID = float(os.getenv("GRID", 0.1))
RAW_DIR = os.getenv("RAW_DIR")
FIRMS_PATH = os.getenv("FIRMS_PATH")
OUTPUT_DIR = os.getenv("OUTPUT_DIR", "./outputs")
RANDOM_STATE = int(os.getenv("RANDOM_STATE", 42))

TEST_SIZE = float(os.getenv("TEST_SIZE", 0.2))
N_ESTIMATORS = int(os.getenv("N_ESTIMATORS", 500))
LEARNING_RATE = float(os.getenv("LEARNING_RATE", 0.05))
NUM_LEAVES = int(os.getenv("NUM_LEAVES", 31))
MIN_CHILD_SAMPLES = int(os.getenv("MIN_CHILD_SAMPLES", 50))

# 🔥 NEW: Prediction window (days ahead)
MAX_PREDICTION_DAYS = 7

os.makedirs(OUTPUT_DIR, exist_ok=True)

assert os.path.exists(RAW_DIR), f"RAW_DIR not found: {RAW_DIR}"
assert os.path.exists(FIRMS_PATH), f"FIRMS_PATH not found: {FIRMS_PATH}"

MODEL_DIR = os.path.join(OUTPUT_DIR, "models")
FEATURE_DIR = os.path.join(OUTPUT_DIR, "features")
META_DIR = os.path.join(OUTPUT_DIR, "metadata")

os.makedirs(MODEL_DIR, exist_ok=True)
os.makedirs(FEATURE_DIR, exist_ok=True)
os.makedirs(META_DIR, exist_ok=True)

# =========================================================
# 1) LOAD & CLEAN RAW SATELLITE DATA
# =========================================================
raw_files = glob.glob(os.path.join(RAW_DIR, "*.csv"))
raw = pd.concat([pd.read_csv(f) for f in raw_files], ignore_index=True)

raw["acq_datetime"] = pd.to_datetime(
    raw["acq_date"].astype(str) + " " +
    raw["acq_time"].astype(str).str.zfill(4),
    errors="coerce"
)
raw["date"] = raw["acq_datetime"].dt.date

raw.rename(columns={"latitude": "lat", "longitude": "lon"}, inplace=True)

raw["bright_main"] = np.nan
if "bright_ti4" in raw.columns:
    raw["bright_main"] = raw["bright_ti4"]
if "bright" in raw.columns:
    raw["bright_main"] = raw["bright_main"].fillna(raw["bright"])

use_cols = ["lat", "lon", "date", "frp", "bright_main", "confidence"]
raw = raw[use_cols].copy()

for c in ["frp", "bright_main", "confidence"]:
    raw[c] = pd.to_numeric(raw[c], errors="coerce")

raw.dropna(subset=["lat", "lon", "date"], inplace=True)

raw["lat_grid"] = (raw["lat"] / GRID).round() * GRID
raw["lon_grid"] = (raw["lon"] / GRID).round() * GRID

# =========================================================
# 2) DAILY AGGREGATION (RAW)
# =========================================================
daily_raw = raw.groupby(
    ["lat_grid", "lon_grid", "date"],
    as_index=False
).agg(
    fire_count=("frp", "count"),
    frp_sum=("frp", "sum"),
    frp_max=("frp", "max"),
    bright_mean=("bright_main", "mean"),
    confidence_mean=("confidence", "mean"),
)

# =========================================================
# 3) LOAD & AGGREGATE FIRMS DATA
# =========================================================
firms = pd.read_csv(FIRMS_PATH)

firms["acq_datetime"] = pd.to_datetime(
    firms["acq_date"].astype(str) + " " +
    firms["acq_time"].astype(str).str.zfill(4),
    errors="coerce"
)
firms["date"] = firms["acq_datetime"].dt.date

firms.rename(columns={"latitude": "lat", "longitude": "lon"}, inplace=True)

firms["bright_main"] = pd.to_numeric(firms["bright_ti4"], errors="coerce")
firms["confidence"] = pd.to_numeric(firms["confidence"], errors="coerce")

firms["lat_grid"] = (firms["lat"] / GRID).round() * GRID
firms["lon_grid"] = (firms["lon"] / GRID).round() * GRID

daily_firms = firms.groupby(
    ["lat_grid", "lon_grid", "date"],
    as_index=False
).agg(
    fire_count=("frp", "count"),
    frp_sum=("frp", "sum"),
    frp_max=("frp", "max"),
    bright_mean=("bright_main", "mean"),
    confidence_mean=("confidence", "mean"),
)

# =========================================================
# 4) MERGE & SORT
# =========================================================
df = pd.concat([daily_raw, daily_firms], ignore_index=True)
df.fillna(0, inplace=True)
df.sort_values(["lat_grid", "lon_grid", "date"], inplace=True)
df.reset_index(drop=True, inplace=True)

# =========================================================
# 5) TEMPORAL FEATURES
# =========================================================
grp = df.groupby(["lat_grid", "lon_grid"])

df["fire_3d"] = grp["fire_count"].rolling(3, min_periods=1).sum().reset_index(drop=True)
df["frp_3d"] = grp["frp_sum"].rolling(3, min_periods=1).sum().reset_index(drop=True)

df["fire_days_7d"] = grp["fire_count"].rolling(7, min_periods=1)\
    .apply(lambda x: (x > 0).sum()).reset_index(drop=True)

df["fire_yesterday"] = grp["fire_count"].shift(1).fillna(0)
df["frp_trend"] = grp["frp_sum"].diff().fillna(0)

# =========================================================
# 6) 🔥 NEW LABEL: DAYS UNTIL NEXT FIRE (0-7 days)
# =========================================================

def calculate_days_until_fire(group):
    """For each row, find days until next fire (within 7 days)"""
    result = []
    dates = group["date"].values
    fire_counts = group["fire_count"].values
    
    for i in range(len(group)):
        current_date = dates[i]
        days_until = -1  # -1 = no fire in next 7 days
        
        # Look ahead 1-7 days
        for j in range(i + 1, min(i + 1 + MAX_PREDICTION_DAYS, len(group))):
            future_date = dates[j]
            days_diff = (future_date - current_date).days
            
            if days_diff > MAX_PREDICTION_DAYS:
                break
                
            if fire_counts[j] > 0:  # Fire detected
                days_until = days_diff
                break
        
        result.append(days_until)
    
    return pd.Series(result, index=group.index)

print("🔄 Calculating days until fire for each location...")
df["days_until_fire"] = grp.apply(calculate_days_until_fire).reset_index(drop=True)

# Filter out rows where we can't predict (last 7 days of data)
df_train = df[df["days_until_fire"] >= 0].copy()

print(f"✅ Training samples with fire within 7 days: {len(df_train)}")
print(f"Distribution of days until fire:")
print(df_train["days_until_fire"].value_counts().sort_index())

# =========================================================
# 7) TRAIN MODEL (REGRESSION)
# =========================================================
FEATURES = [
    "fire_3d",
    "frp_3d",
    "frp_max",
    "fire_days_7d",
    "fire_yesterday",
    "frp_trend",
    "bright_mean",
    "confidence_mean",
]

X = df_train[FEATURES]
y = df_train["days_until_fire"]

X_train, X_val, y_train, y_val = train_test_split(
    X, y,
    test_size=TEST_SIZE,
    random_state=RANDOM_STATE
)

# Use regression model to predict days (0-7)
model = LGBMRegressor(
    objective="regression",
    n_estimators=N_ESTIMATORS,
    learning_rate=LEARNING_RATE,
    num_leaves=NUM_LEAVES,
    min_child_samples=MIN_CHILD_SAMPLES,
    random_state=RANDOM_STATE,
    force_row_wise=True
)

model.fit(X_train, y_train)

# =========================================================
# 8) EVALUATION
# =========================================================
y_pred = model.predict(X_val)
y_pred_clipped = np.clip(np.round(y_pred), 0, MAX_PREDICTION_DAYS)

mae = mean_absolute_error(y_val, y_pred)
rmse = np.sqrt(mean_squared_error(y_val, y_pred))

# Accuracy within ±1 day
within_1day = np.abs(y_pred_clipped - y_val) <= 1
accuracy_1day = within_1day.mean()

print(f"\n📊 MODEL PERFORMANCE")
print(f"MAE (days): {mae:.2f}")
print(f"RMSE (days): {rmse:.2f}")
print(f"Accuracy within ±1 day: {accuracy_1day:.2%}")

# =========================================================
# 9) FEATURE IMPORTANCE
# =========================================================
imp = pd.DataFrame({
    "feature": FEATURES,
    "importance": model.feature_importances_
}).sort_values("importance", ascending=False)

print("\nFEATURE IMPORTANCE")
print(imp)

# =========================================================
# 10) DATASET METADATA
# =========================================================
print("\nDATASET INFO")
print("Latest date   :", df["date"].max())
print("Earliest date :", df["date"].min())
print("Total days    :", df["date"].nunique())
print("Total grids   :", df[["lat_grid", "lon_grid"]].drop_duplicates().shape[0])

# =========================================================
# 11) SAVE MODEL, FEATURES, METADATA
# =========================================================

MODEL_PATH = os.path.join(MODEL_DIR, "lgbm_fire_date_model.pkl")
FEATURE_PATH = os.path.join(FEATURE_DIR, "full_features.csv")
META_PATH = os.path.join(META_DIR, "dataset_info.json")

# save model
joblib.dump(model, MODEL_PATH)

# save full feature dataset (for risk_map)
df.to_csv(FEATURE_PATH, index=False)

# save metadata
metadata = {
    "latest_date": str(df["date"].max()),
    "earliest_date": str(df["date"].min()),
    "total_days": int(df["date"].nunique()),
    "total_grids": int(df[["lat_grid", "lon_grid"]].drop_duplicates().shape[0]),
    "prediction_type": "fire_date",
    "max_prediction_days": MAX_PREDICTION_DAYS,
    "features": FEATURES,
    "model": {
        "type": "LightGBM Regressor",
        "mae_days": round(float(mae), 2),
        "rmse_days": round(float(rmse), 2),
        "accuracy_1day": round(float(accuracy_1day), 4),
        "params": {
            "n_estimators": N_ESTIMATORS,
            "learning_rate": LEARNING_RATE,
            "num_leaves": NUM_LEAVES,
            "min_child_samples": MIN_CHILD_SAMPLES,
        }
    }
}

with open(META_PATH, "w", encoding="utf-8") as f:
    json.dump(metadata, f, indent=2)

print("\n💾 OUTPUT SAVED")
print("Model   :", MODEL_PATH)
print("Features:", FEATURE_PATH)
print("Meta    :", META_PATH)
print("\n✅ FIRE DATE PREDICTION MODEL READY!")

# =========================================================
# 12) GENERATE RISK MAP (GEOJSON FOR FRONTEND)
# =========================================================

print("\n🗺️ Generating fire prediction risk map...")
try:
    from risk_map import run as generate_risk_map
    generate_risk_map()
except Exception as e:
    print(f"⚠️ Warning: Could not generate risk map: {e}")
