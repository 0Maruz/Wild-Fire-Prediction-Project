# =========================================================
# FIRE DATE MAP GENERATION (OBSERVED + PREDICTED DATES)
# =========================================================

import os
import json
import joblib
import numpy as np
import pandas as pd
from datetime import timedelta
from dotenv import load_dotenv

# =========================================================
# CONFIG
# =========================================================

load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL_PATH = os.path.join(BASE_DIR, "outputs", "models", "lgbm_fire_date_model.pkl")
DATA_PATH  = os.path.join(BASE_DIR, "outputs", "features", "full_features.csv")

RISKMAP_DIR  = os.path.join(BASE_DIR, "outputs", "riskmap")
GEOJSON_PATH = os.path.join(RISKMAP_DIR, "fire_dates_all.geojson")
LATEST_PATH  = os.path.join(RISKMAP_DIR, "latest.json")

os.makedirs(RISKMAP_DIR, exist_ok=True)

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

MAX_PREDICTION_DAYS = 7

# =========================================================
# LOAD MODEL & DATA
# =========================================================

def load_assets():
    model = joblib.load(MODEL_PATH)

    df = pd.read_csv(DATA_PATH)
    df["date"] = pd.to_datetime(df["date"]).dt.date

    return model, df


# =========================================================
# BUILD OBSERVED (LATEST REAL DAY)
# =========================================================

def build_observed(df):
    observed_date = df["date"].max()
    obs = df[df["date"] == observed_date].copy()

    return obs, observed_date


# =========================================================
# BUILD PREDICTED (FIRE DATES FOR NEXT 7 DAYS)
# =========================================================

def build_predicted(df, model, base_date):
    base = df[df["date"] == base_date].copy()

    X = base[FEATURES].fillna(0)
    
    # Predict days until fire (0-7)
    days_pred = model.predict(X)
    days_pred_clipped = np.clip(np.round(days_pred), 0, MAX_PREDICTION_DAYS).astype(int)
    
    base["days_until_fire"] = days_pred_clipped
    
    # Calculate actual fire date
    base["predicted_fire_date"] = base["days_until_fire"].apply(
        lambda days: (base_date + timedelta(days=int(days))).strftime("%Y-%m-%d") if days > 0 else "No fire expected"
    )
    
    # Confidence based on prediction value (closer to integer = more confident)
    base["prediction_confidence"] = 1 - np.abs(days_pred - days_pred_clipped)
    
    # Urgency level based on days
    def get_urgency(days):
        if days == 0:
            return "CRITICAL"
        elif days <= 2:
            return "HIGH"
        elif days <= 4:
            return "MEDIUM"
        elif days <= 7:
            return "LOW"
        else:
            return "NONE"
    
    base["urgency_level"] = base["days_until_fire"].apply(get_urgency)

    return base, base_date


# =========================================================
# APPEND TO SINGLE GEOJSON
# =========================================================

def append_geojson(observed, predicted, base_date):
    base_date_str = base_date.strftime("%Y-%m-%d")

    geojson = {"type": "FeatureCollection", "features": []}

    if os.path.exists(GEOJSON_PATH):
        try:
            with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
                geojson = json.load(f)
        except json.JSONDecodeError:
            print("⚠️ Corrupted GeoJSON → recreate")

    # Remove previous predictions for same base date
    geojson["features"] = [
        f for f in geojson["features"]
        if f["properties"].get("base_date") != base_date_str or f["properties"].get("source") == "observed"
    ]

    # ---------- OBSERVED ----------
    for _, r in observed.iterrows():
        geojson["features"].append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(r["lon_grid"]), float(r["lat_grid"])]
            },
            "properties": {
                "date": observed["date"].iloc[0].strftime("%Y-%m-%d"),
                "source": "observed",
                "lat": float(r["lat_grid"]),
                "lon": float(r["lon_grid"]),
                "fire_count": int(r["fire_count"]) if "fire_count" in r else 0
            }
        })

    # ---------- PREDICTED ----------
    for _, r in predicted.iterrows():
        geojson["features"].append({
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(r["lon_grid"]), float(r["lat_grid"])]
            },
            "properties": {
                "base_date": base_date_str,
                "source": "predicted",
                "days_until_fire": int(r["days_until_fire"]),
                "predicted_fire_date": str(r["predicted_fire_date"]),
                "urgency_level": str(r["urgency_level"]),
                "confidence": float(r["prediction_confidence"]),
                "lat": float(r["lat_grid"]),
                "lon": float(r["lon_grid"])
            }
        })

    with open(GEOJSON_PATH, "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2)

    with open(LATEST_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {
                "base_date": base_date_str,
                "observed_date": observed["date"].iloc[0].strftime("%Y-%m-%d"),
                "prediction_horizon_days": MAX_PREDICTION_DAYS
            },
            f,
            indent=2
        )


# =========================================================
# PIPELINE
# =========================================================

def run():
    print("🔄 Loading assets...")
    model, df = load_assets()

    print("📍 Building observed layer...")
    observed, obs_date = build_observed(df)

    print("🔮 Predicting fire dates (1-7 days ahead)...")
    predicted, base_date = build_predicted(df, model, obs_date)

    append_geojson(observed, predicted, base_date)

    print("\n✅ FIRE DATE MAP UPDATED")
    print("Observed date :", obs_date)
    print("Base date     :", base_date)
    print("Prediction    : Fire dates for next 7 days")
    print("GeoJSON       :", GEOJSON_PATH)
    
    # Show summary
    urgency_counts = predicted["urgency_level"].value_counts()
    print("\n📊 URGENCY SUMMARY:")
    for level in ["CRITICAL", "HIGH", "MEDIUM", "LOW", "NONE"]:
        count = urgency_counts.get(level, 0)
        print(f"  {level}: {count} locations")


# =========================================================
# ENTRY
# =========================================================

if __name__ == "__main__":
    run()
