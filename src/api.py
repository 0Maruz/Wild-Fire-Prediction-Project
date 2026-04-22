# =====================================
# FASTAPI BACKEND - FIRE DATE PREDICTION
# =====================================

import os
import json
import joblib
import numpy as np
import pandas as pd
from datetime import timedelta

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# =====================================
# CONFIG
# =====================================

load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL_PATH = os.path.join(BASE_DIR, "outputs", "models", "lgbm_fire_date_model.pkl")
FEATURE_PATH = os.path.join(BASE_DIR, "outputs", "features", "full_features.csv")
META_PATH = os.path.join(BASE_DIR, "outputs", "metadata", "dataset_info.json")
RISKMAP_DIR = os.path.join(BASE_DIR, "outputs", "riskmap")
GEOJSON_PATH = os.path.join(RISKMAP_DIR, "fire_dates_all.geojson")

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

# =====================================
# LOAD ASSETS (ON STARTUP)
# =====================================

app = FastAPI(title="🔥 Fire Date Prediction API", version="2.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def load_assets():
    global model, df

    if not os.path.exists(MODEL_PATH):
        raise RuntimeError("Model not found")

    model = joblib.load(MODEL_PATH)
    df = pd.read_csv(FEATURE_PATH)
    df["date"] = pd.to_datetime(df["date"]).dt.date

    print("✅ Fire Date Prediction Model loaded")

# =====================================
# ROUTES
# =====================================

@app.get("/")
def root():
    return {
        "status": "Fire Date Prediction API running",
        "version": "2.0",
        "prediction_type": "fire_dates",
        "horizon_days": MAX_PREDICTION_DAYS
    }

# -----------------------------
# DATASET METADATA
# -----------------------------
@app.get("/metadata")
def metadata():
    with open(META_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

# -----------------------------
# TODAY'S FIRE DATE PREDICTIONS
# -----------------------------
@app.get("/predictions/today")
def predictions_today():
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()

    X = today[FEATURES].fillna(0)
    
    # Predict days until fire
    days_pred = model.predict(X)
    days_pred_clipped = np.clip(np.round(days_pred), 0, MAX_PREDICTION_DAYS).astype(int)
    
    today["days_until_fire"] = days_pred_clipped
    
    # Calculate actual dates
    today["predicted_fire_date"] = today["days_until_fire"].apply(
        lambda days: (latest_date + timedelta(days=int(days))).strftime("%Y-%m-%d") if days > 0 else None
    )
    
    # Confidence
    today["confidence"] = 1 - np.abs(days_pred - days_pred_clipped)
    
    # Urgency
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
    
    today["urgency_level"] = today["days_until_fire"].apply(get_urgency)
    
    # Summary by urgency
    urgency_summary = today["urgency_level"].value_counts().to_dict()

    return {
        "base_date": str(latest_date),
        "prediction_horizon_days": MAX_PREDICTION_DAYS,
        "total_locations": len(today),
        "urgency_summary": urgency_summary,
        "predictions": today[
            ["lat_grid", "lon_grid", "days_until_fire", "predicted_fire_date", "urgency_level", "confidence"]
        ].to_dict(orient="records")
    }

# -----------------------------
# FIRE DATES BY DAY (TIMELINE)
# -----------------------------
@app.get("/predictions/timeline")
def predictions_timeline():
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()

    X = today[FEATURES].fillna(0)
    days_pred = model.predict(X)
    days_pred_clipped = np.clip(np.round(days_pred), 0, MAX_PREDICTION_DAYS).astype(int)
    
    today["days_until_fire"] = days_pred_clipped
    
    # Group by predicted day
    timeline = {}
    for day in range(0, MAX_PREDICTION_DAYS + 1):
        date_str = (latest_date + timedelta(days=day)).strftime("%Y-%m-%d")
        count = (today["days_until_fire"] == day).sum()
        timeline[date_str] = {
            "days_from_now": day,
            "fire_count": int(count),
            "locations": today[today["days_until_fire"] == day][["lat_grid", "lon_grid"]].to_dict(orient="records")
        }
    
    return {
        "base_date": str(latest_date),
        "timeline": timeline
    }

# -----------------------------
# GEOJSON (FOR MAP)
# -----------------------------
@app.get("/geojson")
def get_geojson():
    if not os.path.exists(GEOJSON_PATH):
        return JSONResponse(
            {"error": "GeoJSON not generated yet"},
            status_code=404
        )
    
    with open(GEOJSON_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

# -----------------------------
# PREDICT SPECIFIC LOCATION
# -----------------------------
@app.get("/predict/location")
def predict_location(lat: float, lon: float, grid_size: float = 0.1):
    # Find nearest grid point
    lat_grid = round(lat / grid_size) * grid_size
    lon_grid = round(lon / grid_size) * grid_size
    
    latest_date = df["date"].max()
    location_data = df[
        (df["date"] == latest_date) &
        (df["lat_grid"] == lat_grid) &
        (df["lon_grid"] == lon_grid)
    ]
    
    if location_data.empty:
        return JSONResponse(
            {"error": f"No data for location ({lat_grid}, {lon_grid})"},
            status_code=404
        )
    
    X = location_data[FEATURES].fillna(0)
    days_pred = model.predict(X)[0]
    days_pred_clipped = int(np.clip(np.round(days_pred), 0, MAX_PREDICTION_DAYS))
    
    fire_date = None
    if days_pred_clipped > 0:
        fire_date = (latest_date + timedelta(days=days_pred_clipped)).strftime("%Y-%m-%d")
    
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
    
    return {
        "location": {
            "lat": lat_grid,
            "lon": lon_grid
        },
        "base_date": str(latest_date),
        "days_until_fire": days_pred_clipped,
        "predicted_fire_date": fire_date,
        "urgency_level": get_urgency(days_pred_clipped),
        "confidence": float(1 - abs(days_pred - days_pred_clipped))
    }
