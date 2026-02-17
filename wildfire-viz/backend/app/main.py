"""
Wildfire Prediction Visualization - Backend API
FastAPI application that receives and serves wildfire prediction data.
The AI model is external — see services/prediction_service.py for integration.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.routes import predictions, health

app = FastAPI(
    title="Wildfire Prediction API",
    description="API for serving wildfire risk prediction data for visualization.",
    version="1.0.0",
)

# Allow ALL origins — fixes browser CORS block
# Note: allow_credentials must be False when allow_origins=["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api", tags=["Health"])
app.include_router(predictions.router, prefix="/api/predictions", tags=["Predictions"])


@app.get("/")
def root():
    return {"message": "Wildfire Prediction API is running. See /docs for endpoints."}