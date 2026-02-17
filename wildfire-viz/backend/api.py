# =====================================
# FASTAPI BACKEND - FIRE RISK
# =====================================

import os
import json
import joblib
import pandas as pd
from datetime import datetime

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

# =====================================
# CONFIG
# =====================================

load_dotenv()

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODEL_PATH = os.path.join(BASE_DIR, "outputs", "models", "lgbm_model.pkl")
FEATURE_PATH = os.path.join(BASE_DIR, "outputs", "features", "full_features.csv")
META_PATH = os.path.join(BASE_DIR, "outputs", "metadata", "dataset_info.json")
RISKMAP_DIR = os.path.join(BASE_DIR, "outputs", "riskmap")

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

# =====================================
# LOAD ASSETS (ON STARTUP)
# =====================================

app = FastAPI(title="🔥 Fire Risk API", version="1.0")

# Add CORS middleware to allow frontend requests
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
    df = pd.read_csv(FEATURE_PATH, parse_dates=["date"])

    print("✅ Model & data loaded")

# =====================================
# ROUTES
# =====================================

@app.get("/")
def root():
    return {"status": "Fire Risk API running"}

# -----------------------------
# DATASET METADATA
# -----------------------------
@app.get("/metadata")
def metadata():
    with open(META_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

# -----------------------------
# TODAY RISK (JSON)
# -----------------------------
@app.get("/risk/today")
def risk_today():
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()

    X = today[FEATURES].fillna(0)
    today["fire_risk"] = model.predict_proba(X)[:, 1]

    return {
        "date": str(latest_date),
        "total_grids": len(today),
        "data": today[
            ["lat_grid", "lon_grid", "fire_risk"]
        ].to_dict(orient="records")
    }

# -----------------------------
# RISK MAP (HTML)
# -----------------------------
@app.get("/risk/map")
def risk_map():
    html_files = sorted(
        [f for f in os.listdir(RISKMAP_DIR) if f.endswith(".html")]
    )

    if not html_files:
        return JSONResponse(
            {"error": "Risk map not generated yet"},
            status_code=404
        )

    latest_map = html_files[-1]
    return FileResponse(
        os.path.join(RISKMAP_DIR, latest_map),
        media_type="text/html"
    )

# -----------------------------
# AUTO GENERATE RISK MAP
# -----------------------------
@app.post("/risk/generate")
def generate_risk_map():
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()

    if today.empty:
        return JSONResponse(
            {"error": "No data for latest date"},
            status_code=400
        )

    # predict
    X = today[FEATURES].fillna(0)
    today["fire_risk"] = model.predict_proba(X)[:, 1]

    today["risk_level"] = pd.cut(
        today["fire_risk"],
        bins=[0, 0.3, 0.6, 1.0],
        labels=["LOW", "MEDIUM", "HIGH"]
    )

    # save files
    csv_path, geo_path = risk_map.save_outputs(today, latest_date)
    html_path = risk_map.build_folium_map(today, latest_date)

    return {
        "status": "success",
        "date": str(latest_date),
        "total_grids": len(today),
        "outputs": {
            "csv": csv_path,
            "geojson": geo_path,
            "html": html_path
        }
    }


# ─────────────────────────────────────
# PREDICTIONS API (for frontend)
# ─────────────────────────────────────

def get_region_from_coords(lat, lon):
    """Map coordinates to Thai regions and provinces"""
    regions = {
        "Northern Thailand": [(12, 20), (97, 102)],
        "Northeast Thailand": [(12, 18), (102, 107)],
        "Central Thailand": [(12, 16), (99, 102)],
        "Eastern Thailand": [(11, 15), (101, 105)],
        "Western Thailand": [(13, 18), (97, 100)],
        "Southern Thailand": [(7, 13), (98, 105)],
    }
    
    for region, (lat_range, lon_range) in regions.items():
        if lat_range[0] <= lat <= lat_range[1] and lon_range[0] <= lon <= lon_range[1]:
            return region
    return "Thailand"

def get_province_name(lat, lon):
    """Map grid coordinates to approximate province"""
    provinces = {
        (19, 99): "Chiang Mai", (20, 100): "Chiang Rai",
        (15, 104): "Ubon Ratchathani", (17, 102): "Khon Kaen",
        (14, 101): "Nakhon Ratchasima", (13, 100): "Bangkok",
        (12, 99): "Ayutthaya", (8, 100): "Phuket",
    }
    
    closest = min(provinces.keys(), key=lambda p: abs(p[0]-lat) + abs(p[1]-lon))
    return provinces.get(closest, "Unknown Province")

@app.get("/api/predictions")
def get_predictions(limit: int = 1000):
    """Get predictions in format expected by frontend"""
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()
    
    if today.empty:
        return {"predictions": []}
    
    X = today[FEATURES].fillna(0)
    today["fire_risk"] = model.predict_proba(X)[:, 1]
    
    predictions = []
    for idx, row in today.iterrows():
        region = get_region_from_coords(row["lat_grid"], row["lon_grid"])
        province = get_province_name(row["lat_grid"], row["lon_grid"])
        
        pred = {
            "latitude": float(row["lat_grid"]),
            "longitude": float(row["lon_grid"]),
            "risk_score": float(row["fire_risk"]),
            "province": province,
            "region": region,
            "timestamp": latest_date.isoformat(),
            "model_ver": "1.0",
            "metadata": {}
        }
        predictions.append(pred)
    
    return {
        "predictions": predictions[:limit],
        "total": len(predictions),
        "date": str(latest_date)
    }

@app.get("/api/predictions/summary")
def get_predictions_summary():
    """Get summary statistics"""
    latest_date = df["date"].max()
    today = df[df["date"] == latest_date].copy()
    
    if today.empty:
        return {
            "total_predictions": 0,
            "average_risk": 0,
            "high_risk_count": 0,
            "critical_count": 0,
            "regions": []
        }
    
    X = today[FEATURES].fillna(0)
    today["fire_risk"] = model.predict_proba(X)[:, 1]
    
    # Add region info
    today["region"] = today.apply(
        lambda row: get_region_from_coords(row["lat_grid"], row["lon_grid"]),
        axis=1
    )
    
    # Calculate stats
    total = len(today)
    avg_risk = float(today["fire_risk"].mean())
    high_count = int((today["fire_risk"] >= 0.7).sum())
    crit_count = int((today["fire_risk"] >= 0.9).sum())
    
    # Group by region
    region_stats = []
    for region in today["region"].unique():
        region_data = today[today["region"] == region]
        region_stats.append({
            "region": region,
            "count": len(region_data),
            "avg_risk": float(region_data["fire_risk"].mean()),
            "max_risk": float(region_data["fire_risk"].max())
        })
    
    region_stats.sort(key=lambda r: r["avg_risk"], reverse=True)
    
    return {
        "total_predictions": total,
        "average_risk": avg_risk,
        "high_risk_count": high_count,
        "critical_count": crit_count,
        "regions": region_stats,
        "date": str(latest_date)
    }

