const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

const PUBLIC_DIR = path.join(__dirname);
const EXPORTS_BASE = path.join(PUBLIC_DIR, 'exports');
fs.mkdirSync(EXPORTS_BASE, { recursive: true });

function makeId() { return Date.now().toString(36).toString('hex'); }

function buildClipWkt(rawClipCoords) {
  if (rawClipCoords == null || rawClipCoords === '') return null;

  let coords;
  try {
    coords = JSON.parse(rawClipCoords);
  } catch (err) {
    throw new Error('invalid clip polygon json');
  }
  if (!Array.isArray(coords) || coords.length < 4) {
    throw new Error('clip polygon requires at least 4 coordinates');
  }

  const points = coords.map((pair) => {
    if (!Array.isArray(pair) || pair.length < 2) {
      throw new Error('invalid clip coordinate pair');
    }
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!isFinite(lon) || !isFinite(lat)) {
      throw new Error('invalid clip coordinate number');
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new Error('clip coordinate out of range');
    }
    return { lon, lat };
  });

  const first = points[0];
  const last = points[points.length - 1];
  const closed = first && last && first.lon === last.lon && first.lat === last.lat;
  if (!closed) {
    points.push({ lon: first.lon, lat: first.lat });
  }

  const unique = new Set(points.slice(0, -1).map(p => `${p.lon.toFixed(8)},${p.lat.toFixed(8)}`));
  if (unique.size < 3) {
    throw new Error('clip polygon must have at least 3 unique points');
  }

  // Para rectángulos rotados: reordenar vértices por ángulo para evitar anillos autocruzados.
  if (unique.size === 4) {
    const uniquePoints = Array.from(
      new Map(points.slice(0, -1).map((p) => [`${p.lon.toFixed(8)},${p.lat.toFixed(8)}`, p])).values()
    );
    const centroid = uniquePoints.reduce((acc, p) => ({
      lon: acc.lon + p.lon,
      lat: acc.lat + p.lat
    }), { lon: 0, lat: 0 });
    centroid.lon /= uniquePoints.length;
    centroid.lat /= uniquePoints.length;

    uniquePoints.sort((a, b) => {
      const angleA = Math.atan2(a.lat - centroid.lat, a.lon - centroid.lon);
      const angleB = Math.atan2(b.lat - centroid.lat, b.lon - centroid.lon);
      return angleA - angleB;
    });

    points.length = 0;
    uniquePoints.forEach((p) => points.push({ lon: p.lon, lat: p.lat }));
    points.push({ lon: uniquePoints[0].lon, lat: uniquePoints[0].lat });
  }

  const wktCoords = points
    .map((p) => `${p.lon.toFixed(8)} ${p.lat.toFixed(8)}`)
    .join(', ');
  return `POLYGON((${wktCoords}))`;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/export', (req, res) => {
  const xmin = req.body.xmin;
  const ymin = req.body.ymin;
  const xmax = req.body.xmax;
  const ymax = req.body.ymax;
  if (![xmin, ymin, xmax, ymax].every(v => v !== undefined)) {
    return res.status(400).send('missing bbox');
  }
  const coords = [xmin, ymin, xmax, ymax].map(Number);
  if (coords.some(c => !isFinite(c))) return res.status(400).send('invalid numbers');
  let clipWkt = null;
  try {
    clipWkt = buildClipWkt(req.body.clip_coords);
  } catch (err) {
    return res.status(400).send('invalid clip polygon');
  }
  if (!clipWkt) {
    return res.status(400).send('missing clip polygon');
  }

  const script = path.join(__dirname, 'run_export.sh');
  if (!fs.existsSync(script) || !(fs.statSync(script).mode & 0o111)) {
    return res.status(500).send('run_export.sh not found or not executable');
  }

  const spawnArgs = coords.map(c => String(c));
  spawnArgs.push(clipWkt);
  const child = spawn(script, spawnArgs);

  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => {
    child.kill();
  }, 10 * 60 * 1000); // 10 min

  child.stdout.on('data', d => stdout += d.toString());
  child.stderr.on('data', d => stderr += d.toString());

  child.on('close', code => {
    clearTimeout(timeout);
    if (code !== 0) return res.status(500).send(stderr);

    const outpath = stdout.trim();
    if (!outpath || !fs.existsSync(outpath)) return res.status(500).send('Output file not found');

    const rel = path.relative(PUBLIC_DIR, outpath).replace(/\\/g, '/');
    let finalPath = outpath;

    if (rel.startsWith('..')) {
      const tmpDir = path.dirname(outpath);
      const hash = path.basename(tmpDir).slice(4);
      const filename = `combined_buildings_${hash}.geojson`;

      finalPath = path.join(EXPORTS_BASE, filename);

      try {
        fs.copyFileSync(outpath, finalPath);
      } catch (err) {
        console.error('copy error', err);
        return res.status(500).send('Failed to copy output file');
      }
    }

    const publicRelative = path.relative(PUBLIC_DIR, finalPath).replace(/\\/g, '/');
    const publicUrl = `${req.protocol}://${req.get('host')}/${publicRelative}`; // no encodeURIComponent
    const filename = path.basename(finalPath);
    res.json({ ok: true, filename, publicUrl });
  });
});

const PORT = process.env.PORT || 8000;
const server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

const shutdown = () => server.close(() => process.exit(0));

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
