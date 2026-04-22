// ===================================
// FIRE DATE PREDICTION DASHBOARD
// ===================================

const map = L.map("map", { 
  center: [13.5, 101], 
  zoom: 6 
});

// Dark map tiles
L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    attribution: '&copy; OpenStreetMap contributors'
  }
).addTo(map);

// State
let geojsonData = null;
let markerLayers = {
  observed: null,
  predicted: null
};

// ===================================
// INITIALIZE
// ===================================

async function init() {
  try {
    const response = await fetch("../outputs/riskmap/fire_dates_all.geojson");
    geojsonData = await response.json();
    
    displayData();
  } catch (error) {
    console.error("Failed to load data:", error);
    alert("Failed to load fire prediction data. Please check if the model has been run.");
  }
}

// ===================================
// DISPLAY DATA
// ===================================

function displayData() {
  if (!geojsonData || !geojsonData.features) return;

  // Clear existing layers
  clearLayers();

  // Separate observed and predicted
  const observed = geojsonData.features.filter(f => f.properties.source === "observed");
  const predicted = geojsonData.features.filter(f => f.properties.source === "predicted");

  // Get base date
  const baseDate = predicted.length > 0 ? predicted[0].properties.base_date : "N/A";
  document.getElementById("baseDate").textContent = baseDate;

  // Create layers
  if (document.getElementById("showObserved").checked) {
    markerLayers.observed = createObservedLayer(observed);
  }

  if (document.getElementById("showPredicted").checked) {
    markerLayers.predicted = createPredictedLayer(predicted);
  }

  // Update statistics
  updateStatistics(predicted);
  updateTimeline(predicted, baseDate);

  // Add layers to map
  addLayersToMap();
}

// ===================================
// CREATE OBSERVED LAYER
// ===================================

function createObservedLayer(features) {
  const cluster = document.getElementById("clusterMarkers").checked;
  const layer = cluster ? L.markerClusterGroup() : L.layerGroup();

  features.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    const props = f.properties;

    const marker = L.circleMarker([lat, lon], {
      radius: 6,
      fillColor: "#ff5722",
      color: "#fff",
      weight: 1,
      fillOpacity: 0.8
    });

    marker.bindPopup(`
      <div style="font-family: system-ui; padding: 4px;">
        <b style="color: #ff5722;">🔥 Observed Fire</b><br>
        <small>Date: ${props.date}</small><br>
        <small>Location: ${lat.toFixed(3)}°, ${lon.toFixed(3)}°</small>
      </div>
    `);

    layer.addLayer(marker);
  });

  return layer;
}

// ===================================
// CREATE PREDICTED LAYER
// ===================================

function createPredictedLayer(features) {
  const cluster = document.getElementById("clusterMarkers").checked;
  const layer = cluster ? L.markerClusterGroup() : L.layerGroup();

  features.forEach(f => {
    const [lon, lat] = f.geometry.coordinates;
    const props = f.properties;

    // Color based on urgency
    const colorMap = {
      "CRITICAL": "#dc2626",
      "HIGH": "#ea580c",
      "MEDIUM": "#f59e0b",
      "LOW": "#10b981",
      "NONE": "#6b7280"
    };

    const color = colorMap[props.urgency_level] || "#6b7280";

    // Size based on urgency
    const sizeMap = {
      "CRITICAL": 9,
      "HIGH": 8,
      "MEDIUM": 7,
      "LOW": 6,
      "NONE": 5
    };

    const size = sizeMap[props.urgency_level] || 5;

    const marker = L.circleMarker([lat, lon], {
      radius: size,
      fillColor: color,
      color: "#fff",
      weight: 1,
      fillOpacity: 0.85
    });

    // Create popup content
    const fireDate = props.predicted_fire_date;
    const daysUntil = props.days_until_fire;
    const confidence = (props.confidence * 100).toFixed(0);

    let popupContent = `
      <div style="font-family: system-ui; padding: 6px; min-width: 200px;">
        <b style="color: ${color};">🔮 Fire Prediction</b><br>
    `;

    if (fireDate && fireDate !== "No fire expected") {
      popupContent += `
        <div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
          <b>Fire Date: ${fireDate}</b><br>
          <small>In ${daysUntil} day${daysUntil !== 1 ? 's' : ''}</small>
        </div>
      `;
    } else {
      popupContent += `
        <div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
          <small>No fire expected in next 7 days</small>
        </div>
      `;
    }

    popupContent += `
        <small>Urgency: <b>${props.urgency_level}</b></small><br>
        <small>Confidence: ${confidence}%</small><br>
        <small>Location: ${lat.toFixed(3)}°, ${lon.toFixed(3)}°</small>
      </div>
    `;

    marker.bindPopup(popupContent);
    layer.addLayer(marker);
  });

  return layer;
}

// ===================================
// UPDATE STATISTICS
// ===================================

function updateStatistics(predicted) {
  const counts = {
    CRITICAL: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0
  };

  predicted.forEach(f => {
    const urgency = f.properties.urgency_level;
    if (urgency in counts) {
      counts[urgency]++;
    }
  });

  document.getElementById("criticalCount").textContent = counts.CRITICAL;
  document.getElementById("highCount").textContent = counts.HIGH;
  document.getElementById("mediumCount").textContent = counts.MEDIUM;
  document.getElementById("lowCount").textContent = counts.LOW;
}

// ===================================
// UPDATE TIMELINE
// ===================================

function updateTimeline(predicted, baseDate) {
  const timeline = document.getElementById("timeline");
  timeline.innerHTML = "";

  // Count fires by days_until_fire
  const dayCounts = {};
  for (let i = 0; i <= 7; i++) {
    dayCounts[i] = 0;
  }

  predicted.forEach(f => {
    const days = f.properties.days_until_fire;
    if (days >= 0 && days <= 7) {
      dayCounts[days]++;
    }
  });

  // Create timeline items
  const baseDateTime = new Date(baseDate);
  
  for (let i = 0; i <= 7; i++) {
    const date = new Date(baseDateTime);
    date.setDate(date.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const count = dayCounts[i];

    const dayLabel = i === 0 ? "Today" : 
                     i === 1 ? "Tomorrow" : 
                     `+${i} days`;

    const item = document.createElement("div");
    item.className = "timeline-item";
    
    if (count > 0) {
      item.classList.add("has-fires");
    }

    item.innerHTML = `
      <div class="timeline-day">${dayLabel}</div>
      <div class="timeline-date">${dateStr}</div>
      <div class="timeline-count">${count} fire${count !== 1 ? 's' : ''}</div>
    `;

    timeline.appendChild(item);
  }
}

// ===================================
// LAYER MANAGEMENT
// ===================================

function clearLayers() {
  if (markerLayers.observed) {
    map.removeLayer(markerLayers.observed);
    markerLayers.observed = null;
  }
  if (markerLayers.predicted) {
    map.removeLayer(markerLayers.predicted);
    markerLayers.predicted = null;
  }
}

function addLayersToMap() {
  if (markerLayers.observed) {
    map.addLayer(markerLayers.observed);
  }
  if (markerLayers.predicted) {
    map.addLayer(markerLayers.predicted);
  }
}

// ===================================
// EVENT LISTENERS
// ===================================

document.getElementById("showObserved").addEventListener("change", displayData);
document.getElementById("showPredicted").addEventListener("change", displayData);
document.getElementById("clusterMarkers").addEventListener("change", displayData);

// ===================================
// START
// ===================================

init();
