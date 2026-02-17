"""
Prediction Routes
─────────────────
GET  /api/predictions/latest       → most recent prediction batch
GET  /api/predictions/run?date=    → trigger model for a specific date
GET  /api/predictions/history      → list of stored batches
POST /api/predictions/ingest       → receive a batch directly from the AI model
"""

from fastapi import APIRouter, HTTPException, Query
from datetime import datetime
from typing import Optional

from ..models.prediction import PredictionBatch, PredictionResponse
from ..services import prediction_service

router = APIRouter()


@router.get("/latest", response_model=PredictionResponse)
def get_latest():
    """Return the most recently stored or generated prediction batch."""
    batch = prediction_service.get_latest_prediction()
    if not batch:
        raise HTTPException(status_code=404, detail="No prediction data available yet.")
    return _to_response(batch)


@router.get("/run", response_model=PredictionResponse)
def run_prediction(
    date: Optional[str] = Query(
        None,
        description="ISO date string (e.g. 2024-03-15). Defaults to today.",
    )
):
    """
    Trigger the AI model for a given date and return results.
    Useful for on-demand prediction requests from the frontend.
    """
    target_date = _parse_date(date) if date else datetime.utcnow()
    batch = prediction_service.run_model_prediction(target_date)
    prediction_service.store_prediction(batch)
    return _to_response(batch)


@router.post("/ingest", response_model=PredictionResponse, status_code=201)
def ingest_prediction(batch: PredictionBatch):
    """
    Receive a prediction batch PUSHED by the AI model pipeline.
    Use this when your model runs on a schedule and pushes results here.
    """
    prediction_service.store_prediction(batch)
    return _to_response(batch)


@router.get("/history")
def get_history():
    """Return a summary list of stored prediction batches."""
    history = prediction_service.get_prediction_history()
    return [
        {
            "prediction_date": b.prediction_date.isoformat(),
            "model_version": b.model_version,
            "total_points": len(b.points),
        }
        for b in history
    ]


# ─── Helper ─────────────────────────────────────────────────────────────────────

def _to_response(batch: PredictionBatch) -> PredictionResponse:
    return PredictionResponse(
        prediction_date=batch.prediction_date.isoformat(),
        model_version=batch.model_version,
        total_points=len(batch.points),
        points=batch.points,
    )


def _parse_date(date_str: str) -> datetime:
    try:
        return datetime.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid date format: '{date_str}'. Use ISO format e.g. '2024-03-15'.",
        )