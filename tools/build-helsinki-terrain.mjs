// tools/build-helsinki-terrain.mjs — bakes the City of Helsinki terrain model (Cesium quantized-mesh, kartta.hel.fi)
// into a height grid in the geodata frame: assets/helsinki-terrain.bin (see js/terrain.js for the format).
// Heights are N2000 metres (the 3D city model uses the same reference, and the sea is at y = 0).
// Water is filled from the nearest shore so that quays don't slope into the sea, and bridges are given straight decks
// between their abutments. usage: node tools/build-helsinki-terrain.mjs [zoom] [out.bin]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const TERRAIN_URL = 'https://kartta.hel.fi/3d/datasource-data/4383570b-33a3-4a9f-ae16-93373aff5ffa/';
export const CELL = 2;
export const MARGIN = 120;
export const HEIGHT_OFFSET = -10;
export const HEIGHT_SCALE = 0.01;
const log = (...a) => console.log('[helsinki-terrain]', ...a);

const zigzag = (v) => (v >> 1) ^ (-(v & 1));

// Decodes the vertices (u, v in 0…32767 across the tile, height in metres) and triangles of a quantized-mesh 1.0 tile.
export function decodeQuantizedMesh(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minHeight = view.getFloat32(24, true), maxHeight = view.getFloat32(28, true);
  let p = 88;
  const count = view.getUint32(p, true); p += 4;
  const read = () => {
    const out = new Uint16Array(count);
    let value = 0;
    for (let i = 0; i < count; i++, p += 2) { value += zigzag(view.getUint16(p, true)); out[i] = value; }
    return out;
  };
  const u = read(), v = read(), h = read();
  const wide = count > 65536;
  if (wide && p % 4) p += 4 - (p % 4);
  const triangles = view.getUint32(p, true); p += 4;
  const indices = wide ? new Uint32Array(triangles * 3) : new Uint16Array(triangles * 3);
  let highest = 0;
  for (let i = 0; i < triangles * 3; i++, p += wide ? 4 : 2) {
    const code = wide ? view.getUint32(p, true) : view.getUint16(p, true);
    indices[i] = highest - code;
    if (code === 0) highest++;
  }
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) heights[i] = minHeight + (maxHeight - minHeight) * h[i] / 32767;
  return { u, v, heights, indices, minHeight, maxHeight };
}

// Geographic extent of a TMS tile in the EPSG:4326 (geographic, 2 × 1 root tiles) scheme.
export function tileExtent(z, x, y) {
  const size = 180 / 2 ** z;
  return { west: -180 + x * size, south: -90 + y * size, east: -180 + (x + 1) * size, north: -90 + (y + 1) * size };
}

export function tileRange(z, west, south, east, north) {
  const size = 180 / 2 ** z;
  return {
    x0: Math.floor((west + 180) / size), x1: Math.floor((east + 180) / size),
    y0: Math.floor((south + 90) / size), y1: Math.floor((north + 90) / size)
  };
}

// Height grid over [minX, minZ] … in `cell` steps (x east, z south); NaN where no triangle covers a sample.
export function createGrid(minX, minZ, maxX, maxZ, cell = CELL) {
  const nx = Math.floor((maxX - minX) / cell) + 1, nz = Math.floor((maxZ - minZ) / cell) + 1;
  return { minX, minZ, cell, nx, nz, heights: new Float32Array(nx * nz).fill(NaN) };
}

export function rasterizeTriangle(grid, ax, az, ah, bx, bz, bh, cx, cz, ch) {
  const { minX, minZ, cell, nx, nz, heights } = grid;
  const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(det) < 1e-12) return;
  const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / cell - 1e-9));
  const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - minX) / cell + 1e-9));
  const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - minZ) / cell - 1e-9));
  const j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) - minZ) / cell + 1e-9));
  for (let j = j0; j <= j1; j++) {
    const z = minZ + j * cell;
    for (let i = i0; i <= i1; i++) {
      const x = minX + i * cell;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-7 || l2 < -1e-7 || l3 < -1e-7) continue;
      heights[j * nx + i] = l1 * ah + l2 * bh + l3 * ch;
    }
  }
}

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Marks samples inside water polygons (minus their islands) as NaN.
export function clearWater(grid, water) {
  const { minX, minZ, cell, nx, nz, heights } = grid;
  let cleared = 0;
  for (const w of water) {
    if (!w.ring || w.ring.length < 6) continue;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < w.ring.length; k += 2) {
      x0 = Math.min(x0, w.ring[k]); x1 = Math.max(x1, w.ring[k]); z0 = Math.min(z0, w.ring[k + 1]); z1 = Math.max(z1, w.ring[k + 1]);
    }
    for (let j = Math.max(0, Math.ceil((z0 - minZ) / cell)); j <= Math.min(nz - 1, Math.floor((z1 - minZ) / cell)); j++) {
      for (let i = Math.max(0, Math.ceil((x0 - minX) / cell)); i <= Math.min(nx - 1, Math.floor((x1 - minX) / cell)); i++) {
        const x = minX + i * cell, z = minZ + j * cell;
        if (!pointInRing(x, z, w.ring) || (w.holes || []).some((h) => pointInRing(x, z, h))) continue;
        heights[j * nx + i] = NaN; cleared++;
      }
    }
  }
  return cleared;
}

// Fills NaN samples with the value of the nearest valid sample (multi-source breadth-first flood).
export function fillFromNearest(grid) {
  const { nx, nz, heights } = grid;
  let queue = [];
  for (let k = 0; k < heights.length; k++) if (!Number.isNaN(heights[k])) queue.push(k);
  if (!queue.length) { heights.fill(0); return; }
  while (queue.length) {
    const next = [];
    for (const k of queue) {
      const i = k % nx, j = (k - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const n = b * nx + a;
        if (Number.isNaN(heights[n])) { heights[n] = heights[k]; next.push(n); }
      }
    }
    queue = next;
  }
}

export function sampleGrid(grid, x, z) {
  const { minX, minZ, cell, nx, nz, heights } = grid;
  const fx = Math.min(nx - 1, Math.max(0, (x - minX) / cell)), fz = Math.min(nz - 1, Math.max(0, (z - minZ) / cell));
  const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - i, tz = fz - j;
  const h = (a, b) => heights[b * nx + a];
  return (h(i, j) * (1 - tx) + h(i + 1, j) * tx) * (1 - tz) + (h(i, j + 1) * (1 - tx) + h(i + 1, j + 1) * tx) * tz;
}

// Bridges get a straight deck between the ground just beyond each end, over the corridor of the way.
export function flattenBridges(grid, roads) {
  const { minX, minZ, cell, nx, nz, heights } = grid;
  const source = { ...grid, heights: heights.slice() };
  let patched = 0;
  for (const road of roads) {
    if (!road.bridge || !road.pts || road.pts.length < 4) continue;
    const pts = [];
    for (let k = 0; k < road.pts.length; k += 2) pts.push({ x: road.pts[k], z: road.pts[k + 1] });
    const lengths = [0];
    for (let k = 1; k < pts.length; k++) lengths.push(lengths[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    const total = lengths[lengths.length - 1];
    if (total < 4) continue;
    const beyond = (a, b) => {
      const d = Math.hypot(a.x - b.x, a.z - b.z) || 1;
      return sampleGrid(source, a.x + (a.x - b.x) / d * 3, a.z + (a.z - b.z) / d * 3);
    };
    const h0 = beyond(pts[0], pts[1]), h1 = beyond(pts[pts.length - 1], pts[pts.length - 2]);
    const half = Math.max(2, (road.width || 4) / 2) + 2;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - half - minX) / cell));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + half - minX) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - half - minZ) / cell));
      const j1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z) + half - minZ) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = minX + i * cell, z = minZ + j * cell;
        const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / len2));
        if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) > half) continue;
        const s = (lengths[k - 1] + t * (lengths[k] - lengths[k - 1])) / total;
        heights[j * nx + i] = h0 + (h1 - h0) * s;
        patched++;
      }
    }
  }
  return patched;
}

export function encodeGrid(grid) {
  const header = 40;
  const buffer = new ArrayBuffer(header + grid.nx * grid.nz * 2);
  const view = new DataView(buffer);
  [0x48, 0x4b, 0x54, 0x52].forEach((c, i) => view.setUint8(i, c)); // "HKTR"
  view.setUint16(4, 1, true);
  view.setFloat32(8, grid.minX, true);
  view.setFloat32(12, grid.minZ, true);
  view.setFloat32(16, grid.cell, true);
  view.setUint32(20, grid.nx, true);
  view.setUint32(24, grid.nz, true);
  view.setFloat32(28, HEIGHT_OFFSET, true);
  view.setFloat32(32, HEIGHT_SCALE, true);
  const data = new Uint16Array(buffer, header);
  for (let k = 0; k < data.length; k++) {
    data[k] = Math.max(0, Math.min(65535, Math.round((grid.heights[k] - HEIGHT_OFFSET) / HEIGHT_SCALE)));
  }
  return new Uint8Array(buffer);
}

async function fetchTile(z, x, y, version, cacheDir) {
  const file = path.join(cacheDir, `${z}_${x}_${y}.terrain`);
  if (fs.existsSync(file)) return new Uint8Array(fs.readFileSync(file));
  const url = `${TERRAIN_URL}${z}/${x}/${y}.terrain?v=${version}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Accept: 'application/vnd.quantized-mesh;extensions=octvertexnormals,*/*;q=0.01' } });
    if (res.status === 404) return null;
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      fs.writeFileSync(file, bytes);
      return bytes;
    }
    if (attempt >= 3) throw new Error(`${url}: ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function main() {
  const zoom = Number(process.argv[2] || 17);
  const out = process.argv[3] || path.join(DIR, '..', 'assets', 'helsinki-terrain.bin');
  const { HELSINKI_DATA } = await import(pathToFileURL(path.join(DIR, '..', 'js', 'helsinki-geodata.js')).href);
  const { lon0, lat0, x: ax, z: az } = HELSINKI_DATA.meta.lonLatAffine;
  const [bx0, bz0, bx1, bz1] = HELSINKI_DATA.meta.bounds;
  const toX = (lon) => ax[0] + ax[1] * (lon - lon0) + ax[2] * 0;
  const toZ = (lat) => az[0] + az[2] * (lat - lat0);
  const grid = createGrid(Math.floor(bx0 - MARGIN), Math.floor(bz0 - MARGIN), Math.ceil(bx1 + MARGIN), Math.ceil(bz1 + MARGIN));
  const lonOf = (x) => lon0 + (x - ax[0]) / ax[1], latOf = (z) => lat0 + (z - az[0]) / az[2];
  const west = lonOf(grid.minX), east = lonOf(grid.minX + (grid.nx - 1) * CELL);
  const north = latOf(grid.minZ), south = latOf(grid.minZ + (grid.nz - 1) * CELL);
  const layer = await (await fetch(TERRAIN_URL + 'layer.json')).json();
  const range = tileRange(zoom, west, south, east, north);
  const cacheDir = path.join(DIR, 'data', 'terrain-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  log(`z${zoom}: ${range.x1 - range.x0 + 1} × ${range.y1 - range.y0 + 1} tiles, grid ${grid.nx} × ${grid.nz} @ ${CELL} m`);
  const jobs = [];
  for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) jobs.push([x, y]);
  let done = 0, vertices = 0;
  const worker = async () => {
    while (jobs.length) {
      const [x, y] = jobs.pop();
      const bytes = await fetchTile(zoom, x, y, layer.version, cacheDir);
      if (bytes) {
        const mesh = decodeQuantizedMesh(bytes);
        const e = tileExtent(zoom, x, y);
        const px = new Float64Array(mesh.u.length), pz = new Float64Array(mesh.u.length);
        for (let k = 0; k < mesh.u.length; k++) {
          px[k] = toX(e.west + (e.east - e.west) * mesh.u[k] / 32767);
          pz[k] = toZ(e.south + (e.north - e.south) * mesh.v[k] / 32767);
        }
        const I = mesh.indices, H = mesh.heights;
        for (let t = 0; t < I.length; t += 3) {
          rasterizeTriangle(grid, px[I[t]], pz[I[t]], H[I[t]], px[I[t + 1]], pz[I[t + 1]], H[I[t + 1]], px[I[t + 2]], pz[I[t + 2]], H[I[t + 2]]);
        }
        vertices += mesh.u.length;
      }
      if (++done % 50 === 0) log(`${done} tiles`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const missing = grid.heights.reduce((n, h) => n + Number.isNaN(h), 0);
  log(`${vertices} vertices; ${missing} samples uncovered`);
  const cleared = clearWater(grid, HELSINKI_DATA.water || []);
  fillFromNearest(grid);
  const patched = flattenBridges(grid, HELSINKI_DATA.roads || []);
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < grid.heights.length; k++) {
    // Land never dips below the water surface (the sim's water level is just under y = 0).
    grid.heights[k] = Math.max(0.2, grid.heights[k]);
    lo = Math.min(lo, grid.heights[k]); hi = Math.max(hi, grid.heights[k]);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const bytes = encodeGrid(grid);
  fs.writeFileSync(out, bytes);
  log(`water ${cleared} samples filled, bridges ${patched} samples; heights ${lo.toFixed(2)} … ${hi.toFixed(2)} m`);
  log(`wrote ${path.relative(process.cwd(), out)} (${(bytes.length / 1048576).toFixed(2)} MB)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
