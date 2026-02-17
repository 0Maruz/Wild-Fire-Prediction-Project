"""
Data models for wildfire prediction results.
These shapes define what the AI model output looks like
and what the frontend receives.
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime
from enum import Enum


class RiskLevel(str, Enum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    VERY_HIGH = "very_high"
    EXTREME = "extreme"


class PredictionPoint(BaseModel):
    """A single geographic prediction point produced by the AI model."""
    lat: float = Field(..., description="Latitude of the prediction cell", ge=-90, le=90)
    lon: float = Field(..., description="Longitude of the prediction cell", ge=-180, le=180)
    risk_score: float = Field(..., description="Normalized risk score [0.0 – 1.0]", ge=0.0, le=1.0)
    risk_level: RiskLevel = Field(..., description="Categorical risk level")
    province: Optional[str] = Field(None, description="Province or region name")
    country: Optional[str] = Field(None, description="Country name")

    # Optional feature inputs (for tooltip display, NOT model re-training)
    temperature: Optional[float] = Field(None, description="Temperature (°C)")
    humidity: Optional[float] = Field(None, description="Relative humidity (%)")
    wind_speed: Optional[float] = Field(None, description="Wind speed (km/h)")
    ndvi: Optional[float] = Field(None, description="Normalized Difference Vegetation Index")


class PredictionBatch(BaseModel):
    """
    A batch of predictions produced by the AI model for a specific date/time.
    This is the schema the AI model should produce and POST to /api/predictions/ingest.
    """
    prediction_date: datetime = Field(..., description="Date/time these predictions apply to")
    model_version: str = Field(..., description="Version tag of the AI model that produced these results")
    points: list[PredictionPoint] = Field(..., description="List of prediction points")


class PredictionResponse(BaseModel):
    """Response returned to the frontend."""
    prediction_date: str
    model_version: str
    total_points: int
    points: list[PredictionPoint]