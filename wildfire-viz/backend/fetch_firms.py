import os
import json
import requests
import pandas as pd
from io import StringIO
from dotenv import load_dotenv

# =========================================================
# LOAD ENV
# =========================================================
load_dotenv()

FIRMS_API_KEY = os.getenv("FIRMS_API_KEY")
if not FIRMS_API_KEY:
    raise RuntimeError("❌ FIRMS_API_KEY not found in .env")

# =========================================================
# CONFIG
# =========================================================
TH_BBOX = "96,4,107,22"   # Thailand

DATASETS = [
    "VIIRS_SNPP_NRT",
    "VIIRS_NOAA20_NRT",
    "VIIRS_NOAA21_NRT",
]

DATA_DIR = os.getenv("DATA_DIR", "./data")
OUT_FILE = os.getenv("FIRMS_OUT", "./data/firms/firms_all.csv")
FIRMS_GEOJSON = os.getenv(
    "FIRMS_GEOJSON",
    "./outputs/firms_today.geojson"
)

os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
os.makedirs(os.path.dirname(FIRMS_GEOJSON), exist_ok=True)

BASE_COLUMNS = [
    "latitude",
    "longitude",
    "acq_date",
    "acq_time",
    "bright_ti4",
    "bright_ti5",
    "scan",
    "track",
    "frp",
    "confidence",
]

# =========================================================
# FETCH FIRMS (TODAY, NRT)
# =========================================================
def fetch_firms_today() -> pd.DataFrame:
    all_dfs = []

    for dataset in DATASETS:
        url = (
            "https://firms.modaps.eosdis.nasa.gov/api/area/csv/"
            f"{FIRMS_API_KEY}/{dataset}/{TH_BBOX}/1"
        )

        print(f"📡 Fetching {dataset}")
        try:
            res = requests.get(url, timeout=30)
        except Exception as e:
            print("❌ Request failed:", e)
            continue

        if res.status_code != 200:
            print(f"❌ HTTP {res.status_code}")
            continue

        df = pd.read_csv(StringIO(res.text))
        if df.empty:
            print(f"⚠️ No data from {dataset}")
            continue

        if not set(BASE_COLUMNS).issubset(df.columns):
            print(f"⚠️ Schema mismatch from {dataset}")
            print(df.columns.tolist())
            continue

        df = df[BASE_COLUMNS].copy()
        df["dataset"] = dataset
        all_dfs.append(df)

    if not all_dfs:
        return pd.DataFrame()

    return pd.concat(all_dfs, ignore_index=True)

# =========================================================
# CLEAN + NORMALIZE
# =========================================================
def clean_firms(df: pd.DataFrame) -> pd.DataFrame:
    # datetime (UTC)
    df["acq_datetime"] = pd.to_datetime(
        df["acq_date"].astype(str) + " " +
        df["acq_time"].astype(str).str.zfill(4),
        format="%Y-%m-%d %H%M",
        errors="coerce"
    )

    # confidence → numeric
    df["confidence"] = pd.to_numeric(
        df["confidence"]
        .map({"l": 0, "n": 50, "h": 100})
        .fillna(df["confidence"]),
        errors="coerce"
    )

    numeric_cols = [
        "latitude", "longitude",
        "bright_ti4", "bright_ti5",
        "scan", "track",
        "frp", "confidence"
    ]
    df[numeric_cols] = df[numeric_cols].apply(
        pd.to_numeric, errors="coerce"
    )

    df.dropna(subset=["latitude", "longitude", "acq_datetime"], inplace=True)

    # convert to Thailand time (UTC+7)
    df["acq_datetime"] = (
        df["acq_datetime"]
        .dt.tz_localize("UTC")
        .dt.tz_convert("Asia/Bangkok")
        .dt.tz_localize(None)
    )

    return df

# =========================================================
# EXPORT GEOJSON (FRONTEND)
# =========================================================
def firms_to_geojson(df: pd.DataFrame, out_path: str):
    features = []

    for _, row in df.iterrows():
        features.append({
            "type": "Feature",
            "properties": {
                "source": "NASA_FIRMS",
                "dataset": row.get("dataset"),
                "confidence": row.get("confidence"),
                "frp": row.get("frp"),
                "datetime": row["acq_datetime"].isoformat()
            },
            "geometry": {
                "type": "Point",
                "coordinates": [
                    float(row["longitude"]),
                    float(row["latitude"])
                ]
            }
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)

    print(f"🗺️ GeoJSON saved → {out_path}")

# =========================================================
# UPDATE (ACCUMULATIVE + TODAY GEOJSON)
# =========================================================
def update_firms():
    new_df = fetch_firms_today()
    if new_df.empty:
        print("⚠️ No new FIRMS data")
        return

    new_df = clean_firms(new_df)

    # load old data
    if os.path.exists(OUT_FILE) and os.path.getsize(OUT_FILE) > 0:
        old_df = pd.read_csv(OUT_FILE)
        old_df["acq_datetime"] = pd.to_datetime(old_df["acq_datetime"])
    else:
        old_df = pd.DataFrame()

    combined = pd.concat([old_df, new_df], ignore_index=True)

    combined.drop_duplicates(
        subset=["latitude", "longitude", "acq_datetime"],
        inplace=True
    )

    combined.sort_values("acq_datetime", inplace=True)
    combined.reset_index(drop=True, inplace=True)

    combined.to_csv(OUT_FILE, index=False)
    print(f"✅ Saved {len(combined)} records → {OUT_FILE}")

    # export today (Thailand date)
    today = pd.Timestamp.now(tz="Asia/Bangkok").date()
    today_df = combined[
        combined["acq_datetime"].dt.date == today
    ]

    if not today_df.empty:
        firms_to_geojson(today_df, FIRMS_GEOJSON)
    else:
        print("⚠️ No FIRMS data for today (GeoJSON not updated)")

# =========================================================
# MAIN
# =========================================================
if __name__ == "__main__":
    print("🚀 Updating FIRMS (VIIRS NRT | accumulative + GeoJSON)")
    update_firms()
