/* global Chart, lucide, L */

/**
 * Dynamic AQI-Based Smart Mobile Air Purification System — Berhampur Map Dashboard
 *
 * Key behavior:
 * - 6 Berhampur locations are treated as monitoring zones
 * - On load / RESET: assign random AQI in [80..220] — NO external API, works fully offline
 * - Every 8 seconds: simulate changing air quality (random walk)
 * - Vehicle logic:
 *   - Identify the zone with highest AQI
 *   - Move vehicle to that zone (smooth animation on map via OSRM road routing)
 *   - While there: AQI decreases by 3–5 points every 3 seconds
 *   - When AQI < 30: move to the next highest AQI zone
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const THRESHOLD = 30;
const AQI_REFRESH_MS = 8000;  // ambient random-walk tick
const PURIFY_TICK_MS = 3000;  // purification tick (3 s)
const MAX_AQI = 350;
const VEHICLE_STEP_MS = 250;  // ms between animation frames along route

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n) => Math.round(n);

// ─── AQI status helpers ───────────────────────────────────────────────────────
function statusForAqi(aqi) {
  if (aqi <= 50) return { label: "Good", key: "good", color: "#4ade80", icon: "leaf" };
  if (aqi <= 100) return { label: "Moderate", key: "mod", color: "#fbbf24", icon: "activity" };
  if (aqi <= 150) return { label: "Unhealthy", key: "unhealthy", color: "#fb923c", icon: "wind" };
  return { label: "Very Unhealthy", key: "crit", color: "#ef4444", icon: "alert-octagon" };
}

// ─── Seeded PRNG (not used for zone AQI, kept for ambient drift) ──────────────
function seededRandom(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────
function $(sel, root = document) { return root.querySelector(sel); }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
}

// ─── Zone definitions (Berhampur, Odisha) ─────────────────────────────────────
function initialZones() {
  return [
    { id: "giri-road", name: "Giri Road", aqi: 0, ll: { lat: 19.3147, lng: 84.7941 } },
    { id: "gate-bazar", name: "Gate Bazar", aqi: 0, ll: { lat: 19.3142, lng: 84.8204 } },
    { id: "annapurna-market", name: "Annapurna Market", aqi: 0, ll: { lat: 19.3156, lng: 84.8217 } },
    { id: "engineering-school-road", name: "Engineering School Road", aqi: 0, ll: { lat: 19.3208, lng: 84.8075 } },
    { id: "lanjipalli", name: "Lanjipalli", aqi: 0, ll: { lat: 19.2955, lng: 84.8048 } },
    { id: "gosaninuagaon", name: "Gosaninuagaon", aqi: 0, ll: { lat: 19.2929, lng: 84.8227 } },
  ];
}

// ─── Simulation helpers ───────────────────────────────────────────────────────
function pickWorstZone(zones) {
  return [...zones].sort((a, b) => b.aqi !== a.aqi ? b.aqi - a.aqi : a.name.localeCompare(b.name))[0];
}

/** Random AQI in [80, 220] ensuring all 6 values are distinct */
function assignRandomAQI(zones) {
  const used = new Set();
  for (const z of zones) {
    let val;
    do { val = 80 + Math.floor(Math.random() * 141); } while (used.has(val));
    used.add(val);
    z.aqi = val;
  }
}

/** Purification delta: -3 to -5 per tick (requested range) */
function computePurificationDelta(aqi) {
  if (aqi >= 200) return -5;
  if (aqi >= 150) return -4;
  return -3;
}

/** Ambient drift for non-target zones */
function computeAmbientDelta(rng, aqi) {
  const noise = (rng() - 0.5) * 10; // ±5
  const drift = aqi > 160 ? 1.2 : aqi > 120 ? 0.7 : aqi > 80 ? 0.3 : 0.0;
  return noise + drift;
}

// ─── Pollutant definitions ─────────────────────────────────────────────────────
const POLLUTANT_DEFS = [
  { id: "pm25", label: "PM2.5", unit: "µg/m³", min: 5, max: 120, icon: "cloud", thresholds: [15, 35, 55] },
  { id: "pm10", label: "PM10", unit: "µg/m³", min: 10, max: 180, icon: "cloud-rain", thresholds: [25, 50, 100] },
  { id: "co", label: "CO", unit: "ppb", min: 10, max: 80, icon: "flame", thresholds: [20, 40, 60] },
  { id: "so2", label: "SO₂", unit: "ppb", min: 1, max: 20, icon: "alert-triangle", thresholds: [5, 10, 15] },
  { id: "no2", label: "NO₂", unit: "ppb", min: 5, max: 60, icon: "zap", thresholds: [15, 30, 45] },
  { id: "o3", label: "O₃", unit: "ppb", min: 10, max: 120, icon: "sun", thresholds: [30, 60, 90] },
];

function pollutantStatus(def, value) {
  const [t1, t2, t3] = def.thresholds;
  if (value <= t1) return { key: "good", color: "#4ade80", label: "Low" };
  if (value <= t2) return { key: "mod", color: "#fbbf24", label: "Moderate" };
  if (value <= t3) return { key: "unhealthy", color: "#fb923c", label: "High" };
  return { key: "crit", color: "#ef4444", label: "Very High" };
}

function randomizePollutants() {
  const out = {};
  for (const def of POLLUTANT_DEFS) {
    out[def.id] = def.min + Math.floor(Math.random() * (def.max - def.min + 1));
  }
  return out;
}

function driftPollutants(pollutants) {
  for (const def of POLLUTANT_DEFS) {
    const delta = (Math.random() - 0.5) * 4; // ±2
    pollutants[def.id] = Math.round(clamp(pollutants[def.id] + delta, def.min, def.max));
  }
}

// ─── State factory (fully synchronous — no API) ───────────────────────────────
function createState() {
  const zones = initialZones();
  assignRandomAQI(zones);                   // random 80–220, all distinct
  const rng = seededRandom(Date.now());   // fresh seed each time for ambient drift
  const worst = pickWorstZone(zones);

  return {
    zones,
    rng,
    paused: false,
    vehicle: {
      mode: "Purifying",
      zoneId: worst.id,
      targetId: worst.id,
      currentLatLng: { ...worst.ll },
      routeDist: 0,
      routeTime: 0,
      routeProgress: 0,
    },
    targetId: worst.id,
    pollutants: randomizePollutants(),
    leaflet: {
      map: null,
      zonesLayer: null,
      zoneMarkers: new Map(),
      vehicleMarker: null,
      routeControl: null,
      routeLine: null,
      routeCoords: [],
      routeAnimTimer: null,
    },
  };
}

// ─── Zone cards ───────────────────────────────────────────────────────────────
function ensureCardsForZones(zones) {
  const root = $("#zoneCards");
  if (!root) return;
  root.innerHTML = "";
  for (const z of zones) {
    const card = el("article", { class: "zone", id: `zone-${z.id}` }, [
      el("div", { class: "zone__top" }, [
        el("div", { class: "zone__name", id: `zoneName-${z.id}`, text: z.name }),
        el("div", { class: "badge", id: `zoneVehicle-${z.id}` }, [
          el("i", { "data-lucide": "truck", "aria-hidden": "true" }),
          el("span", { text: "Vehicle" }),
        ]),
      ]),
      el("div", { class: "zone__aqi", id: `zoneAqi-${z.id}`, text: "—" }),
      el("div", { class: "zone__meta" }, [
        el("span", { class: "badge", id: `zoneStatus-${z.id}` }, [
          el("i", { "data-lucide": "activity", "aria-hidden": "true" }),
          el("span", { text: "—" }),
        ]),
      ]),
    ]);
    root.append(card);
  }
}

function renderCards(state) {
  const root = $("#zoneCards");
  if (!root) return;
  // Rebuild if zone set changed
  if (root.dataset.zonesKey !== state.zones.map(z => z.id).join("|")) {
    ensureCardsForZones(state.zones);
    root.dataset.zonesKey = state.zones.map(z => z.id).join("|");
  }

  for (const z of state.zones) {
    const st = statusForAqi(z.aqi);
    const card = $(`#zone-${z.id}`);
    if (!card) continue;

    card.classList.remove("zone--good", "zone--mod", "zone--unhealthy", "zone--crit", "zone--vehicle");
    card.classList.add(`zone--${st.key}`);

    const hasVehicle = state.vehicle.zoneId === z.id;
    if (hasVehicle) card.classList.add("zone--vehicle");

    const vehicleBadge = $(`#zoneVehicle-${z.id}`);
    if (vehicleBadge) vehicleBadge.style.display = hasVehicle ? "inline-flex" : "none";

    const aqiNode = $(`#zoneAqi-${z.id}`);
    const prev = aqiNode?.dataset.prev ? Number(aqiNode.dataset.prev) : null;
    if (aqiNode) {
      aqiNode.textContent = String(z.aqi);
      aqiNode.dataset.prev = String(z.aqi);
      if (prev !== null && prev !== z.aqi) {
        card.classList.remove("pulse");
        void card.offsetWidth;
        card.classList.add("pulse");
      }
    }

    const statusBadge = $(`#zoneStatus-${z.id}`);
    if (statusBadge)
      statusBadge.innerHTML = `<i data-lucide="${st.icon}" aria-hidden="true"></i><span>${st.label}</span>`;
  }
}

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable(state) {
  const tbody = $("#aqiTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const sorted = [...state.zones].sort((a, b) => b.aqi - a.aqi);
  for (const z of sorted) {
    const st = statusForAqi(z.aqi);
    const tr = document.createElement("tr");
    tr.append(el("td", { text: z.name }));
    tr.append(el("td", { text: String(z.aqi) }));
    const tdStatus = el("td");
    tdStatus.append(el("span", { class: "badge" }, [
      el("span", { class: `sw sw--${st.key}` }),
      document.createTextNode(st.label),
    ]));
    tr.append(tdStatus);
    tbody.append(tr);
  }
}

// ─── Estimates Panel ────────────────────────────────────────────────────────
function formatTime(secs) {
  if (secs <= 0) return "0 sec";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m === 0) return `${s} sec`;
  return `${m} min ${s} sec`;
}

function renderEstimates(state) {
  const elDist = $("#estDist");
  const elTime = $("#estTime");
  const elClean = $("#estClean");
  const rowTravelTime = $("#rowTravelTime");
  if (!elDist || !elTime || !elClean || !rowTravelTime) return;

  const target = state.zones.find(z => z.id === state.targetId);
  const isMoving = state.vehicle.mode === "Moving";

  let purifySecs = 0;
  if (target && target.aqi > THRESHOLD) {
    const avgDropPerTick = 4; // average of 3-5 range
    const ticksNeeded = Math.ceil((target.aqi - THRESHOLD) / avgDropPerTick);
    purifySecs = ticksNeeded * (PURIFY_TICK_MS / 1000);
  }

  if (isMoving) {
    const remainPct = Math.max(0, 1 - state.vehicle.routeProgress);
    const distKm = ((state.vehicle.routeDist * remainPct) / 1000).toFixed(1);
    const timeSecs = state.vehicle.routeTime * remainPct;

    elDist.textContent = `${distKm} km`;
    rowTravelTime.style.display = "block";
    elTime.textContent = formatTime(timeSecs);
    elClean.textContent = formatTime(purifySecs);
  } else {
    elDist.textContent = `0.0 km`;
    rowTravelTime.style.display = "none";
    if (target && target.aqi <= THRESHOLD) {
      elClean.textContent = "Zone Cleaned";
    } else {
      elClean.textContent = formatTime(purifySecs);
    }
  }
}

// ─── Vehicle status panel ─────────────────────────────────────────────────────
function renderVehiclePanel(state) {
  const target = state.zones.find(z => z.id === state.targetId);
  if (!target) return;

  $("#vehicleZone").textContent = target.name;
  $("#vehicleAqi").textContent = String(target.aqi);
  $("#vehicleStatusText").textContent =
    state.vehicle.mode === "Moving" ? "Moving to highest AQI zone…" : "Purifying the target zone…";

  const mode = state.vehicle.mode;
  $("#vehicleModePill").textContent = mode;
  $("#kpiVehicle").textContent = mode;
  $("#kpiTarget").textContent = target.name;

  const worst = pickWorstZone(state.zones);
  $("#kpiWorst").textContent = `${worst.name} • ${worst.aqi}`;

  const pct = clamp(((target.aqi - THRESHOLD) / Math.max(1, 260 - THRESHOLD)) * 100, 0, 100);
  $("#purifyProgress").style.width = `${pct}%`;

  renderEstimates(state);
}

// ─── Bar chart ────────────────────────────────────────────────────────────────
function createBarChart(state) {
  const ctx = $("#aqiBarChart")?.getContext("2d");
  if (!ctx || typeof Chart === "undefined") return null;

  return new Chart(ctx, {
    type: "bar",
    data: {
      labels: state.zones.map(z => z.name),
      datasets: [{
        label: "AQI",
        data: state.zones.map(z => z.aqi),
        borderWidth: 1,
        borderColor: "rgba(122,166,255,.55)",
        backgroundColor: c => statusForAqi(c.raw ?? 0).color + "66",
        hoverBackgroundColor: c => statusForAqi(c.raw ?? 0).color + "99",
        borderRadius: 12,
      }],
    },
    options: {
      responsive: true,
      animation: { duration: 650, easing: "easeOutQuart" },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `AQI: ${c.raw}` } },
      },
      scales: {
        x: { ticks: { color: "rgba(234,242,255,.75)" }, grid: { color: "rgba(140,170,220,.10)" } },
        y: { beginAtZero: true, suggestedMax: 260, ticks: { color: "rgba(234,242,255,.75)" }, grid: { color: "rgba(140,170,220,.10)" } },
      },
    },
  });
}

function updateBarChart(state, chart) {
  if (!chart) return;
  chart.data.labels = state.zones.map(z => z.name);
  chart.data.datasets[0].data = state.zones.map(z => z.aqi);
  chart.update();
}

// ─── Spike (demo) ─────────────────────────────────────────────────────────────
function spikeRandomZone(state) {
  const idx = Math.floor(Math.random() * state.zones.length);
  const z = state.zones[idx];
  z.aqi = round(clamp(z.aqi + 80 + Math.floor(Math.random() * 70), 5, MAX_AQI));
}

// ─── Simulation ticks ─────────────────────────────────────────────────────────
function vehicleTick(state) {
  if (state.paused) return;
  if (state.vehicle.mode !== "Purifying") return;
  const target = state.zones.find(z => z.id === state.targetId);
  if (!target) return;

  target.aqi = round(clamp(target.aqi + computePurificationDelta(target.aqi), 5, MAX_AQI));

  if (target.aqi < THRESHOLD) {
    const next = pickWorstZone(state.zones);
    startVehicleRoute(state, next.id);
  }
}

function aqiRefreshTick(state) {
  if (state.paused) return;
  for (const z of state.zones) {
    const isPurifyingHere = state.vehicle.mode === "Purifying" && z.id === state.targetId;
    if (isPurifyingHere) continue;
    z.aqi = round(clamp(z.aqi + computeAmbientDelta(state.rng, z.aqi), 30, MAX_AQI));
  }
  // Drift pollutant readings slightly each tick
  driftPollutants(state.pollutants);
}

// ─── Pollutant cards renderer ─────────────────────────────────────────────────
function renderPollutants(state) {
  const grid = $("#pollutantGrid");
  if (!grid) return;
  grid.innerHTML = "";
  for (const def of POLLUTANT_DEFS) {
    const val = state.pollutants[def.id];
    const st = pollutantStatus(def, val);
    const card = el("div", { class: `pollutant-card pollutant-card--${st.key}` }, [
      el("div", { class: "pollutant-card__header" }, [
        el("i", { "data-lucide": def.icon, "aria-hidden": "true", class: "pollutant-card__icon" }),
        el("span", { class: "pollutant-card__label", text: def.label }),
      ]),
      el("div", { class: "pollutant-card__body" }, [
        el("span", { class: "pollutant-card__value", text: String(val) }),
        el("span", { class: "pollutant-card__unit", text: def.unit }),
      ]),
      el("div", { class: `pollutant-card__status pollutant-card__status--${st.key}`, text: st.label }),
    ]);
    grid.append(card);
  }
}

// ─── Render all ───────────────────────────────────────────────────────────────
function renderAll(state, chart) {
  renderCards(state);
  renderTable(state);
  renderVehiclePanel(state);
  updateBarChart(state, chart);
  syncLeafletMarkers(state);
  renderPollutants(state);
  lucide.createIcons();
}

// ─── Reset (synchronous) ──────────────────────────────────────────────────────
function reset(state, chart) {
  // Stop any ongoing animation
  stopLeafletRouteAnimation(state);
  if (state.leaflet.routeControl && state.leaflet.map) {
    try { state.leaflet.map.removeControl(state.leaflet.routeControl); } catch (_) { }
    state.leaflet.routeControl = null;
  }
  if (state.leaflet.routeLine) {
    try { state.leaflet.routeLine.remove(); } catch (_) { }
    state.leaflet.routeLine = null;
  }
  state.leaflet.routeCoords = [];

  // Generate fresh random AQI + pollutant values
  assignRandomAQI(state.zones);
  state.pollutants = randomizePollutants();
  state.rng = seededRandom(Date.now());
  state.paused = false;

  // Reset vehicle to worst zone
  const worst = pickWorstZone(state.zones);
  state.targetId = worst.id;
  state.vehicle.mode = "Purifying";
  state.vehicle.zoneId = worst.id;
  state.vehicle.currentLatLng = { ...worst.ll };
  state.vehicle.routeDist = 0;
  state.vehicle.routeTime = 0;
  state.vehicle.routeProgress = 0;

  if (state.leaflet.vehicleMarker)
    state.leaflet.vehicleMarker.setLatLng([worst.ll.lat, worst.ll.lng]);

  const btnP = $("#btnPause");
  if (btnP) btnP.innerHTML = '<i data-lucide="pause" aria-hidden="true"></i>Pause';

  renderAll(state, chart);
}

// ─── Map pin HTML ─────────────────────────────────────────────────────────────
function zonePinHtml(zone) {
  const st = statusForAqi(zone.aqi);
  return `
    <div class="zone-pin zone-pin--${st.key}">
      <div class="zone-pin__top">
        <div class="zone-pin__name">${zone.name}</div>
        <div class="zone-pin__aqi">${zone.aqi}</div>
      </div>
      <div class="zone-pin__status"><span class="sw sw--${st.key}"></span><span>${st.label}</span></div>
    </div>
  `;
}

// ─── Vehicle icon (inline SVG — no external assets) ──────────────────────────
function vehicleIcon() {
  const svg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#5cf2e0"/>
          <stop offset="1" stop-color="#7aa6ff"/>
        </linearGradient>
        <filter id="s" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g filter="url(#s)">
        <rect x="10" y="22" width="30" height="16" rx="6" fill="#0b1426" stroke="url(#g)" stroke-width="3"/>
        <path d="M40 28h8l6 6v4H40z" fill="#0b1426" stroke="url(#g)" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="20" cy="42" r="6" fill="#071225" stroke="url(#g)" stroke-width="3"/>
        <circle cx="44" cy="42" r="6" fill="#071225" stroke="url(#g)" stroke-width="3"/>
        <path d="M14 18c4-4 10-5 15-2" fill="none" stroke="#5cf2e0" stroke-width="3" stroke-linecap="round" opacity=".85"/>
        <path d="M18 14c6-5 15-6 22-2" fill="none" stroke="#7aa6ff" stroke-width="3" stroke-linecap="round" opacity=".65"/>
      </g>
    </svg>
  `);
  return L.icon({
    iconUrl: `data:image/svg+xml,${svg}`,
    iconSize: [45, 45],
    iconAnchor: [22, 22],
    popupAnchor: [0, -20],
    className: "vehicle-marker-anim",
  });
}

// ─── Leaflet map initialisation ───────────────────────────────────────────────
function initLeafletMap(state) {
  const mapEl = document.getElementById("map");
  if (!mapEl || typeof L === "undefined") return;

  try {
    var map = L.map("map", { zoomControl: true }).setView([19.3147, 84.7941], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);

    state.leaflet.map = map;
    state.leaflet.zonesLayer = L.layerGroup().addTo(map);

    // Zone markers
    for (const z of state.zones) {
      const icon = L.divIcon({
        className: "",
        html: zonePinHtml(z),
        iconSize: [170, 68],
        iconAnchor: [85, 68],
      });
      const m = L.marker([z.ll.lat, z.ll.lng], { icon }).addTo(state.leaflet.zonesLayer);
      m.bindPopup(`<strong>${z.name}</strong><br/>AQI: ${z.aqi}`);
      state.leaflet.zoneMarkers.set(z.id, m);
    }

    // Vehicle marker (starts at worst zone)
    const start = state.zones.find(z => z.id === state.targetId) || state.zones[0];
    state.leaflet.vehicleMarker = L.marker(
      [start.ll.lat, start.ll.lng],
      { icon: vehicleIcon() }
    ).addTo(map);
    state.vehicle.currentLatLng = { ...start.ll };
    state.vehicle.mode = "Purifying";
  } catch (err) {
    console.error("Leaflet init error:", err);
  }
}

// ─── Sync zone marker icons with latest AQI ───────────────────────────────────
function syncLeafletMarkers(state) {
  if (!state.leaflet.map) return;
  for (const z of state.zones) {
    const m = state.leaflet.zoneMarkers.get(z.id);
    if (!m) continue;
    m.setIcon(L.divIcon({
      className: "",
      html: zonePinHtml(z),
      iconSize: [170, 68],
      iconAnchor: [85, 68],
    }));
  }
}

// ─── Route animation helpers ──────────────────────────────────────────────────
function stopLeafletRouteAnimation(state) {
  if (state.leaflet.routeAnimTimer) {
    clearInterval(state.leaflet.routeAnimTimer);
    state.leaflet.routeAnimTimer = null;
  }
}

function animateAlongCoords(state, coords, destZone) {
  if (!state.leaflet.vehicleMarker) return;
  if (!coords || coords.length < 2) return;

  let i = 0;
  state.leaflet.routeAnimTimer = setInterval(() => {
    if (state.paused) return;
    i += 1;
    if (i >= coords.length) {
      stopLeafletRouteAnimation(state);
      state.vehicle.mode = "Purifying";
      state.vehicle.zoneId = destZone.id;
      state.vehicle.currentLatLng = { lat: destZone.ll.lat, lng: destZone.ll.lng };
      state.leaflet.vehicleMarker.setLatLng([destZone.ll.lat, destZone.ll.lng]);
      return;
    }
    const p = coords[i];
    state.leaflet.vehicleMarker.setLatLng(p);
    state.vehicle.currentLatLng = { lat: p.lat, lng: p.lng };
    state.vehicle.routeProgress = i / coords.length;
    renderEstimates(state);
  }, VEHICLE_STEP_MS);
}

function startVehicleRoute(state, nextZoneId) {
  if (!state.leaflet.map || !state.leaflet.vehicleMarker) return;
  const destZone = state.zones.find(z => z.id === nextZoneId);
  if (!destZone) return;

  state.vehicle.mode = "Moving";
  state.vehicle.targetId = nextZoneId;
  state.targetId = nextZoneId;

  stopLeafletRouteAnimation(state);

  if (state.leaflet.routeControl) {
    try { state.leaflet.map.removeControl(state.leaflet.routeControl); } catch (_) { }
    state.leaflet.routeControl = null;
  }
  if (state.leaflet.routeLine) {
    try { state.leaflet.routeLine.remove(); } catch (_) { }
    state.leaflet.routeLine = null;
  }

  const origin = L.latLng(state.vehicle.currentLatLng.lat, state.vehicle.currentLatLng.lng);
  const dest = L.latLng(destZone.ll.lat, destZone.ll.lng);

  try {
    const control = L.Routing.control({
      waypoints: [origin, dest],
      router: L.Routing.osrmv1({
        serviceUrl: "https://router.project-osrm.org/route/v1",
        profile: "driving",
      }),
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: false,
      show: false,
      createMarker: () => null,
      lineOptions: {
        styles: [
          { color: "#ff4500", opacity: 0.22, weight: 12 },
          { color: "#ff4500", opacity: 0.90, weight: 6 },
          { color: "#ffaa00", opacity: 0.75, weight: 3 },
        ],
      },
    }).addTo(state.leaflet.map);

    state.leaflet.routeControl = control;

    control.on("routesfound", e => {
      const route = e.routes?.[0];
      const coords = route?.coordinates || [];
      state.leaflet.routeCoords = coords;
      state.vehicle.routeDist = route?.summary?.totalDistance || 0;
      state.vehicle.routeTime = route?.summary?.totalTime || 0;
      state.vehicle.routeProgress = 0;
      animateAlongCoords(state, coords.length >= 2 ? coords : [origin, dest], destZone);
    });
    control.on("routingerror", () => animateAlongCoords(state, [origin, dest], destZone));
  } catch (err) {
    // Fallback: straight-line animation if routing library is unavailable
    console.warn("Routing failed, using straight-line fallback:", err);
    animateAlongCoords(state, [origin, dest], destZone);
  }
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────
function initFullscreen(state) {
  const mapCard = document.getElementById("mapCard");
  const btnEnter = document.getElementById("btnFullscreen");
  const btnExit = document.getElementById("btnExitFullscreen");

  if (!mapCard || !btnEnter || !btnExit) return;

  /** Notify Leaflet its container changed size */
  function invalidateMap() {
    if (state.leaflet.map) {
      setTimeout(() => state.leaflet.map.invalidateSize({ animate: false }), 120);
    }
  }

  /** Enter fullscreen — native API first, CSS class as fallback */
  function enterFullscreen() {
    const fsSupported = document.fullscreenEnabled || document.webkitFullscreenEnabled || document.mozFullScreenEnabled || document.msFullscreenEnabled;

    if (fsSupported) {
      try {
        if (mapCard.requestFullscreen) {
          const promise = mapCard.requestFullscreen();
          if (promise && promise.catch) {
            promise.catch(() => applyCssFullscreen());
          }
        } else if (mapCard.webkitRequestFullscreen) {
          mapCard.webkitRequestFullscreen();
        } else if (mapCard.mozRequestFullScreen) {
          mapCard.mozRequestFullScreen();
        } else if (mapCard.msRequestFullscreen) {
          mapCard.msRequestFullscreen();
        } else {
          applyCssFullscreen();
        }
      } catch (err) {
        applyCssFullscreen();
      }
    } else {
      applyCssFullscreen();
    }
  }

  /** Exit fullscreen — native API first, CSS class fallback */
  function exitFullscreen() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement ||
        document.mozFullScreenElement || document.msFullscreenElement) {
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
          document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
          document.msExitFullscreen();
        }
      } else {
        removeCssFullscreen();
      }
    } catch (err) {
      removeCssFullscreen();
    }
  }

  function applyCssFullscreen() {
    mapCard.classList.add("is-fullscreen");
    document.body.style.overflow = "hidden";
    invalidateMap();
  }

  function removeCssFullscreen() {
    mapCard.classList.remove("is-fullscreen");
    document.body.style.overflow = "";
    invalidateMap();
  }

  // Sync UI when native fullscreen changes (including Escape key)
  function onFullscreenChange() {
    const active = !!(document.fullscreenElement || document.webkitFullscreenElement ||
      document.mozFullScreenElement || document.msFullscreenElement);
    // CSS fallback is not needed here — native handles it
    // But we still need to invalidate the map after the transition
    if (!active) {
      // Also clean up CSS class if it was set concurrently
      mapCard.classList.remove("is-fullscreen");
      document.body.style.overflow = "";
    }
    lucide.createIcons();
    invalidateMap();
  }

  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  document.addEventListener("mozfullscreenchange", onFullscreenChange);
  document.addEventListener("MSFullscreenChange", onFullscreenChange);

  btnEnter.addEventListener("click", enterFullscreen);
  btnExit.addEventListener("click", exitFullscreen);

  // Also allow Escape to exit the CSS-class fullscreen
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && mapCard.classList.contains("is-fullscreen")) {
      removeCssFullscreen();
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────
function init() {
  lucide.createIcons();
  $("#year").textContent = String(new Date().getFullYear());

  const state = createState();      // synchronous — no API calls
  const chart = createBarChart(state);

  initLeafletMap(state);
  renderAll(state, chart);
  initFullscreen(state);

  // UI controls
  $("#btnPause")?.addEventListener("click", () => {
    state.paused = !state.paused;
    const btnP = $("#btnPause");
    if (btnP) btnP.innerHTML = state.paused
      ? '<i data-lucide="play"  aria-hidden="true"></i>Resume'
      : '<i data-lucide="pause" aria-hidden="true"></i>Pause';
    lucide.createIcons();
  });

  $("#btnReset")?.addEventListener("click", () => reset(state, chart));

  $("#btnSpike")?.addEventListener("click", () => {
    spikeRandomZone(state);
    renderAll(state, chart);
  });

  // Simulation loops
  setInterval(() => { aqiRefreshTick(state); renderAll(state, chart); }, AQI_REFRESH_MS);
  setInterval(() => { vehicleTick(state); renderAll(state, chart); }, PURIFY_TICK_MS);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
