// Inicializa mapa centrado en España
var map = L.map('map').setView([36.5, -6.0], 6);

const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 20 }).addTo(map)
const baseLayers = {
  'OpenStreetMap': osm
};

const catastroWMS = L.tileLayer.wms('https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx?', {
    layers: 'Catastro',
    format: 'image/jpeg',
    transparent: true,
    attribution: 'Catastro',
    maxZoom: 20
  })
const overlays = {
  'PNOA': L.tileLayer('https://tms-pnoa-ma.idee.es/1.0.0/pnoa-ma/{z}/{x}/{-y}.jpeg', { attribution: 'PNOA', maxZoom: 20 }),
  'Catastro': catastroWMS,
}

// Handle Catastro tiles errors
const errorPopup = L.popup({ closeButton: true, autoClose: true });
catastroWMS.on('tileerror', function() {
  const errorMessage = "Las teselas de Catastro devuelven error. ¿Estás intentando acceder desde fuera de España?";
  errorPopup.setContent(errorMessage).setLatLng(map.getCenter());
  map.addLayer(errorPopup);
});

L.control.layers(baseLayers, overlays).addTo(map);

// Compat: algunos handlers del plugin Path.Transform esperan helpers no presentes en Leaflet moderno.
if (!L.DomEvent.fakeStop) {
  L.DomEvent.fakeStop = function (e) {
    e._skipped = true;
    L.DomEvent.stop(e);
  };
}
if (!L.DomEvent.skipped) {
  L.DomEvent.skipped = function (e) { return !!e._skipped; };
}

// Silencia logs ruidosos del plugin (caso Object { isTouch: undefined }).
const _origLog = console.log;
console.log = function (...args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'isTouch' in args[0] && Object.keys(args[0]).length === 1) {
    return;
  }
  return _origLog.apply(console, args);
};

var drawnLayer = null;
var drawnItems = new L.FeatureGroup().addTo(map);
var uniformScalingEnabled = true;
var rectangles = [];
var prevActiveOnDraw = null;
const MIN_RECT_AREA_M2 = 100;
var isDrawing = false;
var isBatchExporting = false;
var drawControl = new L.Control.Draw({
  draw: { rectangle: true, polygon: false, polyline: false, circle: false, marker: false, circlemarker: false },
});
map.addControl(drawControl);

const github = L.control({ position: 'topleft' });
const GITHUB_URL = "https://github.com/OSM-es/descarga-catastro"
github.onAdd = function () {
  this._div = L.DomUtil.create('div', 'leaflet-control-zoom leaflet-bar');
  this._div.innerHTML = `<a class="github" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer"><i class="bi bi-github"></i></a>`;
  return this._div;
}
// Búsqueda geocodificada (colocada encima del control de GitHub)
if (window.GeoSearch && GeoSearch.GeoSearchControl && GeoSearch.OpenStreetMapProvider) {
  const search = new GeoSearch.GeoSearchControl({
    provider: new GeoSearch.OpenStreetMapProvider(),
    position: 'topleft'
  });
  map.addControl(search);
}

github.addTo(map);

// key en sessionStorage
const MAP_VIEW = 'descarga-catastro_mapview';

// guarda viewport: centro + zoom y bounds (opcional)
function saveMapView(map) {
  try {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const view = {
      center: { lat: center.lat, lng: center.lng },
      zoom: zoom,
      bounds: {
        southWest: { lat: bounds.getSouthWest().lat, lng: bounds.getSouthWest().lng },
        northEast: { lat: bounds.getNorthEast().lat, lng: bounds.getNorthEast().lng }
      },
      timestamp: Date.now()
    };
    sessionStorage.setItem(MAP_VIEW, JSON.stringify(view));
  } catch (e) {
    console.warn('saveMapView failed', e);
  }
}

// restaura viewport si existe; devuelve true si aplicó algo
function restoreMapView(map) {
  try {
    const raw = sessionStorage.getItem(MAP_VIEW);
    if (!raw) return false;
    const view = JSON.parse(raw);
    if (!view) return false;

    // Preferir centro+zoom; si no está, usar bounds
    if (view.center && typeof view.zoom === 'number') {
      map.setView([view.center.lat, view.center.lng], view.zoom);
      return true;
    } else if (view.bounds && view.bounds.southWest && view.bounds.northEast) {
      const sw = view.bounds.southWest;
      const ne = view.bounds.northEast;
      map.fitBounds([[sw.lat, sw.lng], [ne.lat, ne.lng]]);
      return true;
    }
  } catch (e) {
    console.warn('restoreMapView failed', e);
  }
  return false;
}

// Hookear eventos: guarda cuando el usuario mueve/zoom el mapa
function attachMapViewPersistence(map) {
  // guardar de forma debounced para no spamear sessionStorage
  let timer = null;
  function debounceSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { saveMapView(map); timer = null; }, 300);
  }
  map.on('moveend', debounceSave);
  map.on('zoomend', debounceSave);
}

restoreMapView(map);
attachMapViewPersistence(map);

// Helpers: haversine distance (m)
function toRad(deg) { return deg * Math.PI / 180; }
function haversine(lat1, lon1, lat2, lon2) {
  var R = 6371000;
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lon2 - lon1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Estima área rectangular en m² usando distances N-S y E-W en el centro lat
function estimateRectArea(lonWest, latSouth, lonEast, latNorth) {
  var midLon = (lonWest + lonEast) / 2;
  var h = haversine(latSouth, midLon, latNorth, midLon);
  var midLat = (latSouth + latNorth) / 2;
  var w = haversine(midLat, lonWest, midLat, lonEast);
  return w * h;
}

function setSpanValue(id, val) {
  var span = document.getElementById(id);
  var hidden = document.getElementById(id + '_input');
  if (!span || !hidden) return;
  if (val == null || !Number.isFinite(+val)) {
    span.textContent = span.getAttribute('data-placeholder') || '—';
    span.classList.add('empty');
    hidden.value = '';
  } else {
    span.textContent = (typeof val === 'number') ? val.toFixed(6) : String(val);
    span.classList.remove('empty');
    hidden.value = span.textContent;
  }
}

function setInputsFromBounds(bounds) {
  var xmin = bounds.getWest();
  var ymin = bounds.getSouth();
  var xmax = bounds.getEast();
  var ymax = bounds.getNorth();

  setSpanValue('xmin', xmin);
  setSpanValue('ymin', ymin);
  setSpanValue('xmax', xmax);
  setSpanValue('ymax', ymax);

  updateAreaInfo();
}

// UI: toggle escalado uniforme para transformaciones
const uniformScalingToggle = document.getElementById('uniformScalingToggle');
if (uniformScalingToggle) {
  uniformScalingEnabled = !!uniformScalingToggle.checked;
  uniformScalingToggle.addEventListener('change', function () {
    uniformScalingEnabled = !!uniformScalingToggle.checked;
    if (drawnLayer) {
      disableRectangleTransform(drawnLayer);
      enableRectangleTransform(drawnLayer);
    }
  });
}

function hasValidLatLngs(layer) {
  if (!layer || typeof layer.getLatLngs !== 'function') return false;
  let latlngs = layer.getLatLngs();
  if (!latlngs) return false;
  if (Array.isArray(latlngs[0])) latlngs = latlngs[0]; // polygon ring
  if (!Array.isArray(latlngs) || latlngs.length < 2) return false;
  return latlngs.every(function (p) {
    return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  });
}

function cloneLatLngs(latlngs) {
  if (!Array.isArray(latlngs)) return latlngs;
  return latlngs.map(function (item) {
    if (Array.isArray(item)) return cloneLatLngs(item);
    return L.latLng(item.lat, item.lng, item.alt);
  });
}

function walkLatLngs(latlngs, cb) {
  if (Array.isArray(latlngs)) {
    latlngs.forEach(function (item) { walkLatLngs(item, cb); });
    return;
  }
  if (latlngs && Number.isFinite(latlngs.lat) && Number.isFinite(latlngs.lng)) {
    cb(latlngs);
  }
}

function rebuildLayerBounds(layer) {
  if (!layer || typeof layer.getLatLngs !== 'function') return false;
  const latlngs = layer.getLatLngs();
  if (!latlngs) return false;
  const bounds = L.latLngBounds([]);
  walkLatLngs(latlngs, function (p) {
    bounds.extend(L.latLng(p.lat, p.lng, p.alt));
  });
  if (typeof bounds.isValid === 'function' && !bounds.isValid()) return false;
  let sw;
  let ne;
  try {
    sw = bounds.getSouthWest();
    ne = bounds.getNorthEast();
  } catch (err) {
    return false;
  }
  if (!sw || !ne) return false;
  layer._bounds = L.latLngBounds(
    L.latLng(sw.lat, sw.lng, sw.alt),
    L.latLng(ne.lat, ne.lng, ne.alt)
  );
  return true;
}

function getRectangleCloneOptions(sourceLayer) {
  const sourceOptions = sourceLayer && sourceLayer.options ? sourceLayer.options : {};
  const cloneOptions = {};
  const optionKeys = [
    'stroke',
    'color',
    'weight',
    'opacity',
    'lineCap',
    'lineJoin',
    'dashArray',
    'dashOffset',
    'fill',
    'fillColor',
    'fillOpacity',
    'fillRule',
    'bubblingMouseEvents',
    'interactive',
    'pane',
    'className'
  ];
  optionKeys.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(sourceOptions, key)) {
      cloneOptions[key] = sourceOptions[key];
    }
  });
  return cloneOptions;
}

function getPolygonArea(layer) {
  try {
    if (!hasValidLatLngs(layer) || !L.GeometryUtil || typeof L.GeometryUtil.geodesicArea !== 'function') return null;
    let latlngs = layer.getLatLngs();
    if (Array.isArray(latlngs) && Array.isArray(latlngs[0])) {
      latlngs = latlngs[0];
    }
    if (!latlngs || latlngs.length < 3) return null;
    const area = Math.abs(L.GeometryUtil.geodesicArea(latlngs));
    return Number.isFinite(area) ? area : null;
  } catch (err) {
    return null;
  }
}

function getValidBounds(layer) {
  if (!layer || !layer._map || typeof layer.getBounds !== 'function') return null;
  if (!hasValidLatLngs(layer)) return null;
  let b;
  try {
    b = layer.getBounds();
  } catch (err) {
    return null;
  }
  if (!b || !b.getSouthWest || !b.getNorthEast) return null;
  if (typeof b.isValid === 'function' && !b.isValid()) {
    if (!rebuildLayerBounds(layer)) return null;
    try {
      b = layer.getBounds();
    } catch (err) {
      return null;
    }
    if (!b || (typeof b.isValid === 'function' && !b.isValid())) return null;
  }
  let sw;
  let ne;
  try {
    sw = b.getSouthWest();
    ne = b.getNorthEast();
  } catch (err) {
    return null;
  }
  if (!sw || !ne) return null;
  if (!Number.isFinite(sw.lat) || !Number.isFinite(sw.lng) || !Number.isFinite(ne.lat) || !Number.isFinite(ne.lng)) return null;
  return b;
}

function disableRectangleTransform(layer) {
  if (!layer) return;
  const sync = layer._transformSync;
  layer.off('transform transformstart transformed drag dragend');
  if (layer.transform && typeof layer.transform.disable === 'function') {
    try {
      layer.transform.disable();
    } catch (err) {
      console.warn('PathTransform disable failed:', err);
    }
    if (layer.transform._handlesGroup) {
      try { map.removeLayer(layer.transform._handlesGroup); } catch (e) {}
      layer.transform._handlesGroup = null;
    }
    layer.transform = null;
  }
  if (layer.dragging && typeof layer.dragging.disable === 'function') {
    try {
      layer.dragging.disable();
    } catch (err) {
      console.warn('PathDrag disable failed:', err);
    }
    layer.dragging = null;
  }
  delete layer._transformSync;
}

function setLayerInteractive(layer, enabled) {
  if (!layer) return;
  const path = layer._path;
  if (path) {
    path.style.pointerEvents = enabled ? 'auto' : 'none';
    if (!enabled) path.classList.add('rect-disabled'); else path.classList.remove('rect-disabled');
  }
}

function setAllRectanglesInteractive(enabled) {
  rectangles.forEach(function (r) {
    setLayerInteractive(r, enabled);
  });
}

function getPendingRectangles() {
  return rectangles.filter(function (layer) {
    return !!(layer && layer._map && !layer._exportStatus);
  });
}

function getReusableExportRectangles() {
  return rectangles.filter(function (layer) {
    return !!(layer && layer._map && hasReusableExport(layer));
  });
}

function updatePendingExportButton() {
  const btn = document.getElementById('exportPendingBtn');
  const josmAllBtn = document.getElementById('josmAllBtn');

  const totalPending = getPendingRectangles().length;
  const totalReusable = getReusableExportRectangles().length;

  if (btn) {
    btn.disabled = isBatchExporting || totalPending === 0;
    btn.textContent = totalPending > 0
      ? `Procesar rectángulos ámbar (${totalPending})`
      : 'Procesar rectángulos ámbar';
  }

  if (josmAllBtn) {
    josmAllBtn.disabled = isBatchExporting || totalReusable === 0;
    josmAllBtn.textContent = totalReusable > 0
      ? `JOSM rectángulos verdes (${totalReusable})`
      : 'JOSM rectángulos verdes';
  }
}

function clearLayerExportCache(layer) {
  if (!layer || !layer._exportCache) return;
  if (layer._exportCache.objectUrl) {
    try {
      URL.revokeObjectURL(layer._exportCache.objectUrl);
    } catch (err) {
      console.warn('No se pudo liberar object URL:', err);
    }
  }
  layer._exportCache = null;
}

function resetLayerExportState(layer) {
  if (!layer) return;
  clearLayerExportCache(layer);
  layer._exportStatus = null;
  layer._exportMessage = '';
  updatePendingExportButton();
}

function applyRectStyle(layer, active) {
  if (!layer || typeof layer.setStyle !== 'function') return;
  let color;
  if (layer._exportStatus === 'success') {
    color = '#2ecc71'; // green OK
  } else if (layer._exportStatus === 'error') {
    color = '#e74c3c'; // red error
  } else {
    color = active ? '#3388ff' : '#f1c40f'; // active blue, inactive bright amber
  }
  layer.setStyle({
    color: color,
    fillColor: color,
    fillOpacity: active ? 0.25 : 0.18,
    opacity: 1
  });
}

function setLayerActiveState(layer, active) {
  if (!layer) return;
  const path = layer._path;
  if (path) {
    path.classList.toggle('rect-active', active);
    path.classList.toggle('rect-inactive', !active);
  }
  applyRectStyle(layer, active);
  if (active) {
    enableRectangleTransform(layer);
  } else {
    disableRectangleTransform(layer);
    // Dejar clicable aunque inactivo
    if (path) path.style.pointerEvents = 'auto';
  }
}

function activateRectangle(layer) {
  if (!layer) return;
  if (drawnLayer && drawnLayer !== layer) {
    setLayerActiveState(drawnLayer, false);
  }
  drawnLayer = layer;
  setLayerActiveState(layer, true);
  const b = getValidBounds(layer);
  if (b) setInputsFromBounds(b);
  updateExportStatusUI();
}

function clearBoundsUI() {
  setSpanValue('xmin', null);
  setSpanValue('ymin', null);
  setSpanValue('xmax', null);
  setSpanValue('ymax', null);
  updateExportStatusUI();
}

function removeRectangle(layer) {
  if (!layer) return;
  const idx = rectangles.indexOf(layer);
  disableRectangleTransform(layer);
  clearLayerExportCache(layer);
  map.removeLayer(layer);
  rectangles = rectangles.filter(l => l !== layer);
  updatePendingExportButton();
  const wasActive = layer === drawnLayer;
  if (wasActive) {
    let next = null;
    if (rectangles.length) {
      if (idx > 0 && rectangles[idx - 1]) {
        next = rectangles[idx - 1];
      } else {
        next = rectangles[0];
      }
    }
    drawnLayer = null;
    if (next) {
      activateRectangle(next);
    } else {
      clearBoundsUI();
      updateAreaInfo();
      document.getElementById('exportBtn').disabled = true;
      document.getElementById('josmBtn').disabled = true;
      updateExportStatusUI();
    }
  }
}

function cloneRectangleLayer(sourceLayer) {
  if (!sourceLayer || typeof sourceLayer.getLatLngs !== 'function') return null;
  const latlngs = sourceLayer.getLatLngs();
  if (!latlngs) return null;
  const cloneOptions = getRectangleCloneOptions(sourceLayer);
  const clonedLatLngs = cloneLatLngs(latlngs);

  const clone = L.polygon(clonedLatLngs, cloneOptions).addTo(map);
  rebuildLayerBounds(clone);
  resetLayerExportState(clone);

  setupRectangleLayer(clone);
  activateRectangle(clone);
  setAllRectanglesInteractive(true);
  updateExportStatusUI();
  return clone;
}

function setupRectangleLayer(layer) {
  if (!layer) return;
  rectangles.push(layer);
  updatePendingExportButton();
  layer.on('click', function () {
    if (isDrawing || isBatchExporting) return;
    activateRectangle(layer);
  });
  layer.on('mousedown', function (ev) {
    if (isBatchExporting) return;
    if (ev.originalEvent && ev.originalEvent.button === 1) {
      L.DomEvent.preventDefault(ev.originalEvent);
      L.DomEvent.stopPropagation(ev.originalEvent);
      removeRectangle(layer);
    }
  });
  layer.on('contextmenu', function (ev) {
    if (isDrawing || isBatchExporting) return;
    const originalEvent = ev && ev.originalEvent ? ev.originalEvent : ev;
    if (originalEvent) {
      L.DomEvent.preventDefault(originalEvent);
      L.DomEvent.stopPropagation(originalEvent);
    }
    setTimeout(function () {
      if (!layer || !layer._map) return;
      cloneRectangleLayer(layer);
    }, 0);
  });
  // Asegurar pointer events activos para selección futura
  setLayerInteractive(layer, true);
}

function setLayerExportResult(layer, status, message) {
  if (!layer) return;
  if (status !== 'success') clearLayerExportCache(layer);
  layer._exportStatus = status; // 'success' | 'error'
  layer._exportMessage = message || '';
  applyRectStyle(layer, layer === drawnLayer);
  if (layer === drawnLayer) updateExportStatusUI();
  updatePendingExportButton();
}

function updateExportStatusUI(message) {
  const box = document.getElementById('exportStatus');
  if (!box) return;

  // Mostrar solo si hay rectángulo activo y con estado de export distinto de null
  if (!drawnLayer || !drawnLayer._exportStatus) {
    box.style.display = 'none';
    box.textContent = '';
    box.classList.remove('success', 'error');
    return;
  }

  const status = drawnLayer._exportStatus;
  const msg = message || drawnLayer._exportMessage || (status === 'success' ? 'Exportación completada.' : 'Exportación con errores');

  const label = status === 'success' ? 'ÉXITO' : 'ERROR';
  box.innerHTML = `<div class="label">${label}</div><div>${msg}</div>`;
  box.classList.remove('success', 'error');
  if (status === 'success') box.classList.add('success');
  if (status === 'error') box.classList.add('error');
  box.style.display = 'block';
}

// Delete key removes the active rectangle
document.addEventListener('keydown', function (ev) {
  if (isBatchExporting) return;
  if (ev.key === 'Delete' || ev.key === 'Del' || ev.keyCode === 46) {
    if (drawnLayer) {
      removeRectangle(drawnLayer);
      ev.preventDefault();
    }
  }
});

function enableRectangleTransform(layer) {
  if (!layer) return;
  if (!hasValidLatLngs(layer)) {
    // Esperar a que Leaflet.Draw complete los vértices (caso click-click)
    setTimeout(function () { enableRectangleTransform(layer); }, 50);
    return;
  }
  rebuildLayerBounds(layer);

  function syncBounds() {
    try {
      if (!hasValidLatLngs(layer)) return;
      const b = getValidBounds(layer);
      if (!b) return;
      setInputsFromBounds(b);
    } catch (err) {
      console.debug('syncBounds skipped:', err);
    }
  }
  layer._transformSync = syncBounds;

  // Init handlers if missing
  if ((!layer.transform || typeof layer.transform.enable !== 'function') && L.Handler && L.Handler.PathTransform) {
    try {
      layer.transform = new L.Handler.PathTransform(layer);
    } catch (err) {
      console.warn('No se pudo inicializar PathTransform:', err);
    }
  }

  if (layer.transform && typeof layer.transform.enable === 'function') {
    const transformOptions = {
      rotation: true,
      scaling: true,
      uniformScaling: uniformScalingEnabled
    };
    try {
      layer.transform.enable(transformOptions);
    } catch (err) {
      const repaired = rebuildLayerBounds(layer);
      if (!repaired) {
        console.warn('No se pudo reparar bounds antes de activar transformación:', err);
        return;
      }
      try {
        layer.transform = new L.Handler.PathTransform(layer);
        layer.transform.enable(transformOptions);
      } catch (retryErr) {
        console.warn('No se pudo activar PathTransform tras reintento:', retryErr);
        return;
      }
    }
    layer.off('transform', syncBounds);
    layer.off('transformed', syncBounds);
    layer.on('transform', function () {
      resetLayerExportState(layer);
      applyRectStyle(layer, true);
      updateExportStatusUI();
      syncBounds();
    });
    layer.on('transformed', function () {
      resetLayerExportState(layer);
      applyRectStyle(layer, true);
      updateExportStatusUI();
      syncBounds();
    });
  }

  // Drag support (Path.Drag can also require explicit handler initialization).
  if ((!layer.dragging || typeof layer.dragging.enable !== 'function') && L.Handler && L.Handler.PathDrag) {
    try {
      layer.dragging = new L.Handler.PathDrag(layer);
    } catch (err) {
      console.warn('No se pudo inicializar PathDrag:', err);
    }
  }

  if (layer.dragging && typeof layer.dragging.enable === 'function') {
    layer.dragging.enable();
    layer.off('drag', syncBounds);
    layer.off('dragend', syncBounds);
    layer.on('drag', function () {
      resetLayerExportState(layer);
      applyRectStyle(layer, true);
      updateExportStatusUI();
      syncBounds();
    });
    layer.on('dragend', function () {
      resetLayerExportState(layer);
      applyRectStyle(layer, true);
      updateExportStatusUI();
      syncBounds();
    });
  }

  const b = getValidBounds(layer);
  if (b) setInputsFromBounds(b);
}
map.on(L.Draw.Event.DRAWSTART, function () {
  if (isBatchExporting) return;
  isDrawing = true;
  setAllRectanglesInteractive(false);
  // Inactivar el actual mientras se dibuja uno nuevo
  if (drawnLayer) {
    prevActiveOnDraw = drawnLayer;
    setLayerActiveState(drawnLayer, false);
  } else {
    prevActiveOnDraw = null;
  }
  drawnLayer = null;
  clearBoundsUI();
  updateAreaInfo();
  document.getElementById('exportBtn').disabled = true;
  document.getElementById('josmBtn').disabled = true;
  updateExportStatusUI();
});

map.on(L.Draw.Event.CREATED, function (e) {
  if (isBatchExporting) return;
  const layer = e.layer.addTo(map);
  resetLayerExportState(layer);

  // calcular área; si es demasiado pequeña, eliminar y restaurar anterior
  const areaPoly = getPolygonArea(layer);
  const b = getValidBounds(layer);
  const areaBBox = b ? estimateRectArea(b.getWest(), b.getSouth(), b.getEast(), b.getNorth()) : null;
  const areaM2 = areaPoly != null ? areaPoly : areaBBox;

  if (areaM2 != null && areaM2 < MIN_RECT_AREA_M2) {
    map.removeLayer(layer);
    if (prevActiveOnDraw) {
      setLayerActiveState(prevActiveOnDraw, true);
      drawnLayer = prevActiveOnDraw;
      const bPrev = getValidBounds(prevActiveOnDraw);
      if (bPrev) setInputsFromBounds(bPrev);
    } else {
      drawnLayer = null;
      clearBoundsUI();
      updateAreaInfo();
      document.getElementById('exportBtn').disabled = true;
      document.getElementById('josmBtn').disabled = true;
    }
    isDrawing = false;
    setAllRectanglesInteractive(true);
    return;
  }

  setupRectangleLayer(layer);
  activateRectangle(layer);
  isDrawing = false;
  setAllRectanglesInteractive(true);
  updateExportStatusUI();
});

map.on(L.Draw.Event.DRAWSTOP, function () {
  if (isBatchExporting) return;
  if (isDrawing) {
    isDrawing = false;
    setAllRectanglesInteractive(true);
  }
});

function readCoords() {
  var xmin = parseFloat(document.getElementById('xmin_input').value);
  var ymin = parseFloat(document.getElementById('ymin_input').value);
  var xmax = parseFloat(document.getElementById('xmax_input').value);
  var ymax = parseFloat(document.getElementById('ymax_input').value);
  return { xmin: xmin, ymin: ymin, xmax: xmax, ymax: ymax };
}

function updateAreaInfo() {
  var coords = readCoords();
  var xmin = coords.xmin, ymin = coords.ymin, xmax = coords.xmax, ymax = coords.ymax;
  var areaText = document.getElementById('areaInfo');
  var tooLarge = document.getElementById('tooLarge');
  var exportBtn = document.getElementById('exportBtn');
  var josmBtn = document.getElementById('josmBtn');

  // Área real (polígono) y área del bbox; mostramos ambas si difieren.
  var polyArea = drawnLayer ? getPolygonArea(drawnLayer) : null;
  var bboxArea = null;
  if ([xmin, ymin, xmax, ymax].every(function (v) { return Number.isFinite(v); })) {
    bboxArea = estimateRectArea(xmin, ymin, xmax, ymax);
  }

  // Para validar límite, tomamos el peor caso: max(polígono, bbox).
  var limitArea = Math.max(polyArea != null ? polyArea : 0, bboxArea != null ? bboxArea : 0);

  // Texto al usuario: mostrar limitArea y, si existe, el área real.
  if (!Number.isFinite(limitArea) || limitArea === 0) {
    areaText.textContent = '—';
    tooLarge.style.display = 'none';
    exportBtn.disabled = false;
    josmBtn.disabled = false;
    return;
  }

  var limitKm2 = limitArea / 1e6;
  var baseArea = Number.isFinite(polyArea) ? polyArea : bboxArea;
  var rotArea = Number.isFinite(bboxArea) ? bboxArea : polyArea;
  var baseKm2 = Number.isFinite(baseArea) ? baseArea / 1e6 : limitKm2;
  var pills = [];

  // Siempre mostrar el área base (polígono real si existe, si no bbox).
  pills.push('<span class="pill pill-alt">Base: ' + baseKm2.toFixed(4) + ' km²</span>');

  // Mostrar Giro solo si hay ambos valores y la diferencia es apreciable (0.5% o >1 m²).
  var showRot = Number.isFinite(rotArea) && Number.isFinite(baseArea);
  if (showRot) {
    var diff = Math.abs(rotArea - baseArea);
    var rotated = diff > Math.max(1, baseArea * 0.005);
    if (rotated) {
      pills.push('<span class="pill">Giro: ' + (rotArea / 1e6).toFixed(4) + ' km²</span>');
    }
  }

  // Si solo hay un valor válido, no añadimos Giro extra.

  areaText.innerHTML = '<div class="pill-row">' + pills.join('') + '</div>';

  if (limitArea > 0.5e6) {
    tooLarge.style.display = 'block';
    exportBtn.disabled = true;
    josmBtn.disabled = true;
  } else {
    tooLarge.style.display = 'none';
    exportBtn.disabled = false;
    josmBtn.disabled = false;
  }
}

// Modal helpers
let progressTimer = null;

function setModalMessage(message) {
  const msg = document.getElementById('modalMsg');
  if (msg) msg.textContent = message;
}

function setModalProgress(percent) {
  const fill = document.getElementById('progressFill');
  if (!fill) return;
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  fill.style.width = safe.toFixed(1) + '%';
}

function showModal(options) {
  const opts = options || {};
  const indeterminate = !opts.determinate;
  document.getElementById('modalOverlay').style.display = 'flex';
  setModalMessage(opts.message || 'Generando fichero, espera...');
  stopProgress(false);
  if (indeterminate) {
    startProgress();
  } else {
    setModalProgress(opts.progress || 0);
  }
}

function updateBatchModal(completed, total) {
  const safeTotal = total > 0 ? total : 1;
  setModalMessage(`Procesando, espera... (${completed}/${total} completados)`);
  setModalProgress((completed / safeTotal) * 100);
}

function hideModal() {
  stopProgress(true);
  document.getElementById('modalOverlay').style.display = 'none';
}

document.getElementById('copyBtn').addEventListener('click', function () {
  if (isBatchExporting) return;
  var coords = readCoords();
  if (![coords.xmin, coords.ymin, coords.xmax, coords.ymax].every(function (v) { return Number.isFinite(v); })) {
    return;
  }
  var text = [coords.xmin, coords.ymin, coords.xmax, coords.ymax].join(" ");
  navigator.clipboard.writeText(text).catch(function (err) {
    console.error('No se pudo copiar: ', err);
  }).then(function () {
    var btn = document.getElementById('copyBtn');
    if (!btn) return;
    var originalHTML = btn.innerHTML;
    var checkIcon = '<i class="bi bi-check-lg"></i>';
    btn.classList.add('copied');
    btn.innerHTML = checkIcon;
    setTimeout(function () {
      btn.classList.remove('copied');
      btn.innerHTML = originalHTML;
    }, 1400);
  });
});

function startProgress() {
  const fill = document.getElementById('progressFill');
  if (!fill) return;
  stopProgress(false);
  let pct = 0;
  fill.style.width = '0%';
  progressTimer = setInterval(() => {
    pct += Math.random() * 8;
    if (pct > 95) pct = 95;
    fill.style.width = pct.toFixed(1) + '%';
  }, 400);
}
function stopProgress(completeBar) {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  if (completeBar) {
    setModalProgress(100);
  }
}

function getLayerCoords(layer) {
  const b = getValidBounds(layer);
  if (!b) throw new Error('Coordenadas inválidas.');
  return {
    xmin: b.getWest(),
    ymin: b.getSouth(),
    xmax: b.getEast(),
    ymax: b.getNorth()
  };
}

function validateLayerAreaForExport(layer, coords) {
  const polyArea = getPolygonArea(layer);
  const bboxArea = estimateRectArea(coords.xmin, coords.ymin, coords.xmax, coords.ymax);
  const limitArea = Math.max(polyArea != null ? polyArea : 0, bboxArea != null ? bboxArea : 0);
  const areaForCheck = Number.isFinite(limitArea) && limitArea > 0 ? limitArea : (polyArea != null ? polyArea : bboxArea);
  if (!Number.isFinite(areaForCheck) || limitArea > 0.5e6) {
    throw new Error('Acércate — el área máxima permitida es 0.5 km².');
  }
}

async function requestLayerExport(coords) {
  const data = new URLSearchParams();
  data.set('xmin', String(coords.xmin));
  data.set('ymin', String(coords.ymin));
  data.set('xmax', String(coords.xmax));
  data.set('ymax', String(coords.ymax));

  const resp = await fetch('/export', {
    method: 'POST',
    body: data
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(txt || 'Server error');
  }

  const j = await resp.json();
  if (!j.ok || !j.publicUrl) throw new Error('No public URL returned');
  return j;
}

async function cacheLayerExport(layer, exportInfo) {
  if (!layer || !exportInfo) return null;
  clearLayerExportCache(layer);
  const cache = {
    filename: exportInfo.filename || 'catastro.geojson',
    publicUrl: exportInfo.publicUrl,
    objectUrl: null
  };

  try {
    const fileResp = await fetch(exportInfo.publicUrl);
    if (fileResp.ok) {
      const blob = await fileResp.blob();
      cache.objectUrl = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.warn('No se pudo cachear el GeoJSON localmente:', err);
  }

  layer._exportCache = cache;
  return cache;
}

async function exportLayer(layer) {
  if (!layer) throw new Error('No hay rectángulo activo.');
  const coords = getLayerCoords(layer);
  validateLayerAreaForExport(layer, coords);
  const exportInfo = await requestLayerExport(coords);
  await cacheLayerExport(layer, exportInfo);
  return exportInfo;
}

function hasReusableExport(layer) {
  return !!(
    layer &&
    layer._exportStatus === 'success' &&
    layer._exportCache &&
    layer._exportCache.publicUrl
  );
}

function triggerBrowserDownload(url, filename) {
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildJosmImportUrl(publicUrl, layerName) {
  const params = new URLSearchParams();
  params.set('new_layer', 'true');
  params.set('changeset_tags', `source=Dirección General del Catastro|created_by=${GITHUB_URL}|hashtags=catastro-es`);
  if (layerName) params.set('layer_name', layerName);
  params.set('url', publicUrl);
  return `http://127.0.0.1:8111/import?${params.toString()}`;
}

function sendLayerToJosm(layer, layerName) {
  if (!layer || !layer._exportCache || !layer._exportCache.publicUrl) return false;
  const josmUrl = buildJosmImportUrl(layer._exportCache.publicUrl, layerName);
  window.open(josmUrl);
  return true;
}

function triggerLayerAction(layer, action) {
  if (!hasReusableExport(layer)) return false;
  const chosenAction = action === 'josm' ? 'josm' : 'download';

  if (chosenAction === 'josm') {
    return sendLayerToJosm(layer);
  }

  const downloadUrl = layer._exportCache.objectUrl || layer._exportCache.publicUrl;
  triggerBrowserDownload(downloadUrl, layer._exportCache.filename);
  return true;
}

function sendAllGreenToJosm() {
  if (isBatchExporting) return;
  const reusableLayers = getReusableExportRectangles();
  if (!reusableLayers.length) {
    alert('No hay rectángulos verdes disponibles para enviar a JOSM.');
    return;
  }

  reusableLayers.forEach(function (layer, idx) {
    const layerName = `catastro_${String(idx + 1).padStart(2, '0')}`;
    sendLayerToJosm(layer, layerName);
  });
}

async function exportPendingRectangles() {
  if (isBatchExporting) return;
  const pending = getPendingRectangles();
  if (!pending.length) return;

  isBatchExporting = true;
  updatePendingExportButton();
  setAllRectanglesInteractive(false);
  showModal({
    determinate: true,
    message: `Procesando, espera... (0/${pending.length} completados)`,
    progress: 0
  });

  let completed = 0;
  const total = pending.length;
  try {
    for (const layer of pending) {
      if (!layer || !layer._map) {
        completed += 1;
        updateBatchModal(completed, total);
        continue;
      }
      try {
        await exportLayer(layer);
        setLayerExportResult(layer, 'success', 'Exportación completada.');
      } catch (err) {
        const message = (err && err.message) ? err.message : 'Error en la exportación';
        setLayerExportResult(layer, 'error', message);
      }
      completed += 1;
      updateBatchModal(completed, total);
    }
  } finally {
    isBatchExporting = false;
    hideModal();
    setAllRectanglesInteractive(true);
    if (drawnLayer) {
      applyRectStyle(drawnLayer, true);
      updateExportStatusUI();
    }
    updatePendingExportButton();
  }
}

document.getElementById('exportPendingBtn').addEventListener('click', function () {
  if (isBatchExporting) return;
  exportPendingRectangles();
});

document.getElementById('josmAllBtn').addEventListener('click', function () {
  if (isBatchExporting) return;
  sendAllGreenToJosm();
});

document.getElementById('bboxForm').addEventListener('submit', async function (ev) {
  ev.preventDefault();
  if (isBatchExporting) return;
  if (!drawnLayer) {
    alert('No hay rectángulo activo.');
    return;
  }

  const submitter = ev.submitter || document.activeElement;
  const action = (submitter && submitter.dataset && submitter.dataset.action) ? submitter.dataset.action : 'download';

  if (hasReusableExport(drawnLayer)) {
    triggerLayerAction(drawnLayer, action);
    return;
  }

  showModal({ message: 'Generando fichero, espera...' });

  try {
    await exportLayer(drawnLayer);
    setLayerExportResult(drawnLayer, 'success', 'Exportación completada.');
    triggerLayerAction(drawnLayer, action);
  } catch (err) {
    const message = (err && err.message) ? err.message : 'Error en la exportación';
    setLayerExportResult(drawnLayer, 'error', message);
  } finally {
    hideModal();
  }
});

window.addEventListener('beforeunload', function () {
  rectangles.forEach(function (layer) {
    clearLayerExportCache(layer);
  });
});

updatePendingExportButton();
