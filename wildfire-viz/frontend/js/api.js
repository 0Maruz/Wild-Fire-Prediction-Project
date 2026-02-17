/**
 * api.js — HTTP client for the Wildfire Prediction API
 * All calls go through these functions so the base URL is managed here.
 */

const API = (() => {

  // ─── Change this to your deployed backend URL ────────────────────
  const BASE_URL = 'http://localhost:5000/api';
  // ────────────────────────────────────────────────────────────────

  async function _get(path) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    return res.json();
  }

  /**
   * Fetch the most recent prediction batch.
   * @returns {Promise<PredictionResponse>}
   */
  async function getLatest() {
    return _get('/predictions/latest');
  }

  /**
   * Ask the backend to run the AI model for a specific date.
   * @param {string} isoDate - e.g. "2024-03-15"
   * @returns {Promise<PredictionResponse>}
   */
  async function runPrediction(isoDate) {
    const param = isoDate ? `?date=${encodeURIComponent(isoDate)}` : '';
    return _get(`/predictions/run${param}`);
  }

  /**
   * Health check.
   * @returns {Promise<{status: string, timestamp: string}>}
   */
  async function health() {
    return _get('/health');
  }

  return { getLatest, runPrediction, health };

})();