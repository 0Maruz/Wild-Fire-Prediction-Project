/**
 * app.js — Main application controller
 */

(async () => {

  // ── State
  let allPoints   = [];
  let threshold   = 0;
  const visibility = { heatmap: true, markers: false, grid: true };

  // ── DOM refs
  const datePicker     = document.getElementById('date-picker');
  const btnRun         = document.getElementById('btn-run');
  const statusPill     = document.getElementById('status-pill');
  const statusText     = document.getElementById('status-text');
  const loadingOverlay = document.getElementById('loading-overlay');

  const toggleHeatmap  = document.getElementById('toggle-heatmap');
  const toggleMarkers  = document.getElementById('toggle-markers');
  const toggleGrid     = document.getElementById('toggle-grid');
  const toggleBorders  = document.getElementById('toggle-borders');
  const riskSlider     = document.getElementById('risk-slider');
  const sliderVal      = document.getElementById('slider-val');

  const statTotal   = document.getElementById('stat-total');
  const statExtreme = document.getElementById('stat-extreme');
  const statHigh    = document.getElementById('stat-high');
  const statModel   = document.getElementById('stat-model');

  // ── Helpers
  function setStatus(type, msg) {
    statusPill.className = `status-pill status-${type}`;
    statusText.textContent = msg;
  }

  function showLoading(show) {
    loadingOverlay.classList.toggle('hidden', !show);
    btnRun.disabled = show;
  }

  function updateStats(data) {
    statTotal.textContent   = data.total_points.toLocaleString();
    statModel.textContent   = data.model_version;
    const extreme = data.points.filter(p => p.risk_score >= 0.8).length;
    const high    = data.points.filter(p => p.risk_score >= 0.6 && p.risk_score < 0.8).length;
    statExtreme.textContent = extreme.toLocaleString();
    statHigh.textContent    = high.toLocaleString();
  }

  function updateSliderGradient(val) {
    riskSlider.style.background =
      `linear-gradient(to right, var(--accent) ${val}%, var(--panel-border) ${val}%)`;
  }

  function applyRender() {
    MapController.render(allPoints, threshold, { ...visibility });
  }

  // ── Default date to today
  datePicker.value = new Date().toISOString().split('T')[0];

  // ── Initial load — skip health check, go straight to data
  setStatus('loading', 'Connecting...');
  await loadPrediction(null);

  // ── Load predictions
  async function loadPrediction(isoDate) {
    showLoading(true);
    setStatus('loading', 'Loading...');
    try {
      const data = isoDate
        ? await API.runPrediction(isoDate)
        : await API.getLatest();

      allPoints = data.points;
      updateStats(data);
      applyRender();
      MapController.fitToRegion();

      setStatus('ok', `${data.prediction_date.slice(0, 10)} · ${data.total_points} pts`);
    } catch (err) {
      // Show detailed error in status to help debug
      console.error('Prediction load error:', err);
      const msg = err.message || 'Failed to fetch';
      setStatus('error', msg);

      // Print troubleshooting info to console
      console.group('🔥 Pyrowatch — Connection Troubleshooting');
      console.log('Attempted URL: http://localhost:5000/api/predictions/latest');
      console.log('Error:', err);
      console.log('Steps to fix:');
      console.log('1. Is the backend running? → cd backend && uvicorn app.main:app --reload --port 5000');
      console.log('2. Open http://localhost:5000/api/health in a new tab — does it return JSON?');
      console.log('3. Check the Network tab in DevTools for the exact failed request');
      console.groupEnd();
    } finally {
      showLoading(false);
    }
  }

  // ── Controls
  btnRun.addEventListener('click', () => loadPrediction(datePicker.value || null));
  datePicker.addEventListener('keydown', e => { if (e.key === 'Enter') btnRun.click(); });

  toggleHeatmap.addEventListener('change', () => {
    visibility.heatmap = toggleHeatmap.checked;
    applyRender();
  });

  toggleMarkers.addEventListener('change', () => {
    visibility.markers = toggleMarkers.checked;
    applyRender();
  });

  toggleGrid.addEventListener('change', () => {
    visibility.grid = toggleGrid.checked;
    applyRender();
  });

  toggleBorders.addEventListener('change', () => {
    MapController.toggleBorders(toggleBorders.checked);
  });

  riskSlider.addEventListener('input', () => {
    const pct = parseInt(riskSlider.value, 10);
    threshold = pct / 100;
    sliderVal.textContent = `${pct}%`;
    updateSliderGradient(pct);
    applyRender();
  });

})();