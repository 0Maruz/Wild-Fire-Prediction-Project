/**
 * map.js — Leaflet map
 *  - Tight heatmap (no blob overlap)
 *  - Land-only rendering via topojson masking
 *  - Circle markers scaled by risk
 */

const MapController = (() => {

  const RISK_COLORS = {
    low:       '#1a9641',
    moderate:  '#a6d96a',
    high:      '#ffffbf',
    very_high: '#fdae61',
    extreme:   '#d73027',
  };

  function scoreToColor(score) {
    if (score < 0.20) return RISK_COLORS.low;
    if (score < 0.40) return RISK_COLORS.moderate;
    if (score < 0.60) return RISK_COLORS.high;
    if (score < 0.80) return RISK_COLORS.very_high;
    return RISK_COLORS.extreme;
  }

  function scoreToOpacity(score) {
    return 0.25 + score * 0.55;
  }

  // ── Map init ──────────────────────────────────────────────────
  const map = L.map('map', {
    center: [16.0, 101.5],
    zoom: 6,
    minZoom: 4,
    maxZoom: 14,
    zoomControl: true,
    maxBounds: [[-5, 85], [35, 120]],
    maxBoundsViscosity: 0.8,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; OSM contributors',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // ── Country IDs (numeric ISO 3166-1) ─────────────────────────
  // Thailand=764, Myanmar=104, Laos=418, Cambodia=116,
  // Vietnam=704, Malaysia=458, China=156, Bangladesh=50, India=356
  const REGION_IDS = new Set([764, 104, 418, 116, 704, 458, 156, 50, 356]);

  let _landPolygons = [];
  let _bordersReady = false;
  let borderLayer = L.layerGroup().addTo(map);

  async function loadBorders() {
    try {
      const res  = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json');
      const topo = await res.json();
      const geojson = topojson.feature(topo, topo.objects.countries);

      const regional = {
        type: 'FeatureCollection',
        features: geojson.features.filter(f => REGION_IDS.has(Number(f.id))),
      };

      L.geoJSON(regional, {
        style: { color: '#ff9800', weight: 1.5, opacity: 0.6, fillOpacity: 0 },
      }).addTo(borderLayer);

      // Cache land rings for masking
      regional.features.forEach(f => {
        const g = f.geometry;
        if (g.type === 'Polygon') {
          _landPolygons.push(g.coordinates[0]);
        } else if (g.type === 'MultiPolygon') {
          g.coordinates.forEach(p => _landPolygons.push(p[0]));
        }
      });

      _bordersReady = true;
      console.log(`✅ ${_landPolygons.length} land polygons loaded`);
    } catch (err) {
      console.warn('⚠️ Border load failed — masking disabled:', err.message);
      _bordersReady = true;
    }
  }

  // ── Ray-casting point-in-polygon ─────────────────────────────
  function _pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; // [lon, lat]
      const [xj, yj] = ring[j];
      if (((yi > lat) !== (yj > lat)) &&
          (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function _isOnLand(lat, lon) {
    if (!_landPolygons.length) return true; // fallback if not loaded
    return _landPolygons.some(ring => _pointInRing(lat, lon, ring));
  }

  // ── Layer groups ──────────────────────────────────────────────
  let heatLayer   = null;
  let markerGroup = L.layerGroup().addTo(map);
  let gridGroup   = L.layerGroup().addTo(map);

  // ── Tooltip ──────────────────────────────────────────────────
  const tooltip    = document.getElementById('tooltip');
  const ttCoords   = document.getElementById('tt-coords');
  const ttCountry  = document.getElementById('tt-country');
  const ttProvince = document.getElementById('tt-province');
  const ttScore    = document.getElementById('tt-score');
  const ttLevel    = document.getElementById('tt-level');
  const ttTemp     = document.getElementById('tt-temp');
  const ttHum      = document.getElementById('tt-hum');
  const ttWind     = document.getElementById('tt-wind');
  const ttNdvi     = document.getElementById('tt-ndvi');

  async function showTooltip(e, pt) {
    ttCoords.textContent   = `${pt.lat.toFixed(3)}°N, ${pt.lon.toFixed(3)}°E`;
    ttCountry.textContent  = '…';
    ttProvince.textContent = '…';
    ttScore.textContent    = `${(pt.risk_score * 100).toFixed(1)}%`;
    ttLevel.textContent    = pt.risk_level.replace(/_/g, ' ').toUpperCase();
    ttLevel.style.color    = scoreToColor(pt.risk_score);
    ttTemp.textContent     = pt.temperature != null ? `${pt.temperature}°C`   : '—';
    ttHum.textContent      = pt.humidity    != null ? `${pt.humidity}%`       : '—';
    ttWind.textContent     = pt.wind_speed  != null ? `${pt.wind_speed} km/h` : '—';
    ttNdvi.textContent     = pt.ndvi        != null ? pt.ndvi.toFixed(3)      : '—';

    _positionTooltip(e);
    tooltip.classList.remove('hidden');

    const loc = await Geocoder.lookup(pt.lat, pt.lon);
    ttCountry.textContent  = loc.country  || '—';
    ttProvince.textContent = loc.province || '—';
  }

  function _positionTooltip(e) {
    const pad = 14, tw = 230, th = 240;
    let x = e.clientX + 16, y = e.clientY - 10;
    if (x + tw > window.innerWidth)  x = e.clientX - tw - pad;
    if (y + th > window.innerHeight) y = window.innerHeight - th - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top  = `${y}px`;
  }

  function hideTooltip() { tooltip.classList.add('hidden'); }

  // ── Render ────────────────────────────────────────────────────
  function render(points, threshold = 0, visibility = { heatmap: true, markers: false, grid: true }) {
    const filtered = points.filter(p => p.risk_score >= threshold);

    if (!_bordersReady) {
      setTimeout(() => render(points, threshold, visibility), 400);
      return;
    }

    // Only keep land points for grid/markers
    const landPoints = filtered.filter(p => _isOnLand(p.lat, p.lon));

    _renderHeatmap(landPoints, visibility.heatmap);
    _renderMarkers(landPoints, visibility.markers);
    _renderGrid(landPoints, visibility.grid);
  }

  function _renderHeatmap(points, visible) {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!visible || !points.length) return;

    const heat = points.map(p => [p.lat, p.lon, p.risk_score]);
    heatLayer = L.heatLayer(heat, {
      // Small radius = tight hotspots, no overlap
      radius:     14,
      blur:       10,
      maxZoom:    10,
      max:        1.0,
      minOpacity: 0.4,
      gradient: {
        0.0:  '#1a9641',
        0.40: '#a6d96a',
        0.60: '#ffffbf',
        0.75: '#fdae61',
        0.90: '#f46d43',
        1.0:  '#d73027',
      },
    }).addTo(map);
  }

  function _renderMarkers(points, visible) {
    markerGroup.clearLayers();
    if (!visible || !points.length) return;

    points.forEach(pt => {
      const circle = L.circleMarker([pt.lat, pt.lon], {
        radius:      3 + pt.risk_score * 7,
        fillColor:   scoreToColor(pt.risk_score),
        color:       'rgba(0,0,0,0.3)',
        weight:      1,
        fillOpacity: 0.85,
      });
      circle.on('mouseover', e => showTooltip(e.originalEvent, pt));
      circle.on('mouseout',  hideTooltip);
      markerGroup.addLayer(circle);
    });
  }

  function _renderGrid(points, visible) {
    gridGroup.clearLayers();
    if (!visible || !points.length) return;

    points.forEach(pt => {
      const circle = L.circleMarker([pt.lat, pt.lon], {
        // Scale radius with risk — high risk = bigger dot
        radius:      6 + pt.risk_score * 12,
        fillColor:   scoreToColor(pt.risk_score),
        color:       'transparent',
        weight:      0,
        fillOpacity: scoreToOpacity(pt.risk_score),
      });
      circle.on('mouseover', e => showTooltip(e.originalEvent, pt));
      circle.on('mouseout',  hideTooltip);
      circle.on('mousemove', e => _positionTooltip(e));
      gridGroup.addLayer(circle);
    });
  }

  // ── Toggles ───────────────────────────────────────────────────
  function toggleHeatmap(on) {
    if (heatLayer) { on ? map.addLayer(heatLayer) : map.removeLayer(heatLayer); }
  }
  function toggleMarkers(on) { on ? map.addLayer(markerGroup) : map.removeLayer(markerGroup); }
  function toggleGrid(on)    { on ? map.addLayer(gridGroup)   : map.removeLayer(gridGroup); }
  function toggleBorders(on) { on ? map.addLayer(borderLayer) : map.removeLayer(borderLayer); }

  function fitToRegion() {
    map.fitBounds([[5.0, 97.0], [28.5, 108.0]], { padding: [20, 20] });
  }

  loadBorders();

  return { render, toggleHeatmap, toggleMarkers, toggleGrid, toggleBorders, fitToRegion };

})();