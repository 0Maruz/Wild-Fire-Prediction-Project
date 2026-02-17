"""
Prediction Service — Integration point between AI model and visualization API.
See TODO comments to connect your real model.
"""

import random
from datetime import datetime
from typing import Optional

from app.models.prediction import PredictionBatch, PredictionPoint, RiskLevel

_latest_prediction: Optional[PredictionBatch] = None
_prediction_history: list[PredictionBatch] = []

# ── TODO: Import your AI model here ──────────────────────────────────
# from your_model_package import WildfireModel
# _model = WildfireModel.load("path/to/weights.pt")
# ─────────────────────────────────────────────────────────────────────


def run_model_prediction(target_date: datetime) -> PredictionBatch:
    """
    TODO: Replace mock below with your real model:
        raw = _model.predict(target_date)
        points = [PredictionPoint(lat=r["lat"], lon=r["lon"],
                  risk_score=r["score"], risk_level=_score_to_level(r["score"]))
                  for r in raw]
        return PredictionBatch(prediction_date=target_date,
                               model_version="v1.0", points=points)
    """
    return _generate_mock_data(target_date)


def store_prediction(batch: PredictionBatch) -> None:
    global _latest_prediction
    _latest_prediction = batch
    _prediction_history.append(batch)
    if len(_prediction_history) > 30:
        _prediction_history.pop(0)


def get_latest_prediction() -> Optional[PredictionBatch]:
    global _latest_prediction
    if _latest_prediction is None:
        _latest_prediction = _generate_mock_data(datetime.utcnow())
    return _latest_prediction


def get_prediction_history() -> list[PredictionBatch]:
    return list(reversed(_prediction_history))


def _score_to_level(score: float) -> RiskLevel:
    if score < 0.2:  return RiskLevel.LOW
    if score < 0.4:  return RiskLevel.MODERATE
    if score < 0.6:  return RiskLevel.HIGH
    if score < 0.8:  return RiskLevel.VERY_HIGH
    return RiskLevel.EXTREME


def _generate_mock_data(target_date: datetime) -> PredictionBatch:
    random.seed(int(target_date.timestamp()) % 10000)

    # ── Tightly-defined hotspots — spread ≤ 1.0° so blobs stay separate ──
    # Each spread value = degrees radius (~110 km max)
    hotspots = [
        # Northern Thailand dry season burn areas
        {"lat_c": 19.5,  "lon_c": 99.2,  "intensity": 0.88, "spread": 0.9},
        {"lat_c": 18.8,  "lon_c": 98.5,  "intensity": 0.75, "spread": 0.7},
        # Chiang Rai / Golden Triangle
        {"lat_c": 20.1,  "lon_c": 100.1, "intensity": 0.70, "spread": 0.8},
        # Mae Hong Son ridge fires
        {"lat_c": 18.3,  "lon_c": 97.9,  "intensity": 0.92, "spread": 0.7},
        # Tak / western Thailand
        {"lat_c": 16.8,  "lon_c": 98.6,  "intensity": 0.60, "spread": 0.6},
        # Laos border — Loei / Nong Khai
        {"lat_c": 17.9,  "lon_c": 102.6, "intensity": 0.58, "spread": 0.8},
        # Northern Laos
        {"lat_c": 20.5,  "lon_c": 102.0, "intensity": 0.55, "spread": 0.9},
        # Central Laos
        {"lat_c": 16.5,  "lon_c": 104.8, "intensity": 0.50, "spread": 0.7},
        # Cambodia — Siem Reap / Mondulkiri
        {"lat_c": 13.4,  "lon_c": 104.0, "intensity": 0.52, "spread": 0.8},
        {"lat_c": 12.8,  "lon_c": 107.0, "intensity": 0.45, "spread": 0.7},
        # Myanmar — Shan / Kayah
        {"lat_c": 20.8,  "lon_c": 97.5,  "intensity": 0.65, "spread": 0.8},
        {"lat_c": 18.5,  "lon_c": 96.9,  "intensity": 0.50, "spread": 0.7},
        # Southern Thailand (very low risk — rainy)
        {"lat_c": 8.0,   "lon_c": 99.8,  "intensity": 0.22, "spread": 0.5},
    ]

    points: list[PredictionPoint] = []
    grid_step = 0.25  # ~28 km resolution

    for lat in _frange(5.5, 28.5, grid_step):
        for lon in _frange(96.5, 108.0, grid_step):
            # Composite: take strongest hotspot influence at this cell
            score = 0.0
            for h in hotspots:
                dist = ((lat - h["lat_c"]) ** 2 + (lon - h["lon_c"]) ** 2) ** 0.5
                # Sharp falloff: influence drops to 0 at spread distance
                influence = h["intensity"] * max(0.0, 1.0 - (dist / h["spread"]) ** 1.5)
                score = max(score, influence)

            # Small noise (keep tight so hotspots don't bleed)
            score = max(0.0, min(1.0, score + random.gauss(0, 0.025)))

            # Only include cells with meaningful risk (≥ 15%)
            # This prevents filling ocean / background with near-zero noise
            if score < 0.15:
                continue

            points.append(
                PredictionPoint(
                    lat=round(lat, 4),
                    lon=round(lon, 4),
                    risk_score=round(score, 4),
                    risk_level=_score_to_level(score),
                    temperature=round(random.uniform(28, 42), 1),
                    humidity=round(random.uniform(10, 65), 1),
                    wind_speed=round(random.uniform(5, 40), 1),
                    ndvi=round(random.uniform(0.1, 0.7), 3),
                )
            )

    return PredictionBatch(
        prediction_date=target_date,
        model_version="mock-v1.0",
        points=points,
    )


def _frange(start: float, stop: float, step: float):
    x = start
    while x < stop:
        yield round(x, 6)
        x += step