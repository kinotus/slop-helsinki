// js/terrain.js — real ground elevation from the City of Helsinki terrain model (baked by tools/build-helsinki-terrain.mjs
// into assets/helsinki-terrain.bin: N2000 metres on a 2 m grid in the geodata frame).
//
// The simulation (traffic, pedestrians, trams, colliders…) keeps working in its flat, ground-relative frame; what is
// drawn is lifted by groundAt(x, z). The ground surface is piecewise linear on a MESH_CELL grid whose cells are split
// along their x + z diagonal, so static meshes clipped along the same lines (terrain-drape.js) lie exactly on it and
// moving things placed with groundAt() stand exactly on the draped roads.
//
// With no terrain loaded (node tests, `?terrain=flat`, or a failed download) groundAt() is 0 and everything is flat.

export const MESH_CELL = 8;
// Height (N2000) of the flat world's water surface once the terrain is on: the sea.
export const SEA_LEVEL = 0;

const state = { surface: null, raster: null };

export function decodeTerrain(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'HKTR' || view.getUint16(4, true) !== 1) throw new Error('not a Helsinki terrain grid (HKTR v1)');
  const minX = view.getFloat32(8, true), minZ = view.getFloat32(12, true), cell = view.getFloat32(16, true);
  const nx = view.getUint32(20, true), nz = view.getUint32(24, true);
  const offset = view.getFloat32(28, true), scale = view.getFloat32(32, true);
  const heights = new Float32Array(nx * nz);
  for (let k = 0; k < heights.length; k++) heights[k] = offset + view.getUint16(40 + k * 2, true) * scale;
  return { minX, minZ, cell, nx, nz, heights };
}

// Bilinear sample of a raster, clamped to its edges.
export function sampleRaster(r, x, z) {
  const fx = Math.min(r.nx - 1, Math.max(0, (x - r.minX) / r.cell));
  const fz = Math.min(r.nz - 1, Math.max(0, (z - r.minZ) / r.cell));
  const i = Math.min(r.nx - 2, Math.floor(fx)), j = Math.min(r.nz - 2, Math.floor(fz));
  const tx = fx - i, tz = fz - j, h = r.heights, n = r.nx;
  return (h[j * n + i] * (1 - tx) + h[j * n + i + 1] * tx) * (1 - tz) + (h[(j + 1) * n + i] * (1 - tx) + h[(j + 1) * n + i + 1] * tx) * tz;
}

// Node heights on the MESH_CELL lattice (nodes at integer multiples of `cell`) covering the raster.
export function buildSurface(raster, cell = MESH_CELL) {
  const i0 = Math.ceil(raster.minX / cell), j0 = Math.ceil(raster.minZ / cell);
  const i1 = Math.floor((raster.minX + (raster.nx - 1) * raster.cell) / cell);
  const j1 = Math.floor((raster.minZ + (raster.nz - 1) * raster.cell) / cell);
  const nx = i1 - i0 + 1, nz = j1 - j0 + 1;
  const heights = new Float32Array(nx * nz);
  // Each node takes the mean of the raster around it (a cell-wide box), so the coarser lattice isn't aliased.
  const taps = [-0.5, -0.25, 0, 0.25, 0.5];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = (i0 + i) * cell, z = (j0 + j) * cell;
    let sum = 0;
    for (const a of taps) for (const b of taps) sum += sampleRaster(raster, x + a * cell, z + b * cell);
    heights[j * nx + i] = sum / (taps.length * taps.length);
  }
  return { cell, i0, j0, nx, nz, heights, minX: i0 * cell, minZ: j0 * cell, maxX: i1 * cell, maxZ: j1 * cell };
}

export function setTerrain(raster, cell = MESH_CELL) {
  state.raster = raster;
  state.surface = raster ? buildSurface(raster, cell) : null;
  return state.surface;
}

export const terrainEnabled = () => state.surface !== null;
export const terrainSurface = () => state.surface;

// Height of the piecewise linear ground at (x, z): 0 without terrain; clamped to the lattice's edge outside it.
export function surfaceHeight(s, x, z) {
  const fx = Math.min(s.nx - 1, Math.max(0, x / s.cell - s.i0));
  const fz = Math.min(s.nz - 1, Math.max(0, z / s.cell - s.j0));
  const i = Math.min(s.nx - 2, Math.floor(fx)), j = Math.min(s.nz - 2, Math.floor(fz));
  const u = fx - i, v = fz - j, h = s.heights, n = s.nx;
  const h00 = h[j * n + i], h10 = h[j * n + i + 1], h01 = h[(j + 1) * n + i], h11 = h[(j + 1) * n + i + 1];
  return u + v <= 1 ? h00 + (h10 - h00) * u + (h01 - h00) * v : h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
}

export function groundAt(x, z) {
  return state.surface ? surfaceHeight(state.surface, x, z) : 0;
}

// Upward unit normal of the ground triangle under (x, z).
export function groundNormal(x, z, out = { x: 0, y: 1, z: 0 }) {
  const s = state.surface;
  if (!s) { out.x = 0; out.y = 1; out.z = 0; return out; }
  const fx = x / s.cell - s.i0, fz = z / s.cell - s.j0;
  if (fx <= 0 || fz <= 0 || fx >= s.nx - 1 || fz >= s.nz - 1) {
    // Outside the lattice the clamped surface only varies along the edge; keep it simple and level.
    out.x = 0; out.y = 1; out.z = 0; return out;
  }
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, h = s.heights, n = s.nx;
  let gx, gz;
  if (u + v <= 1) {
    gx = h[j * n + i + 1] - h[j * n + i]; gz = h[(j + 1) * n + i] - h[j * n + i];
  } else {
    gx = h[(j + 1) * n + i + 1] - h[(j + 1) * n + i]; gz = h[(j + 1) * n + i + 1] - h[j * n + i + 1];
  }
  gx /= s.cell; gz /= s.cell;
  const l = Math.hypot(gx, 1, gz);
  out.x = -gx / l; out.y = 1 / l; out.z = -gz / l;
  return out;
}

// Slope pitch (radians, nose up positive) for something at (x, z) heading along (fx, fz), measured over `half` m.
export function groundPitch(x, z, fx, fz, half = 2) {
  if (!state.surface) return 0;
  return Math.atan2(groundAt(x + fx * half, z + fz * half) - groundAt(x - fx * half, z - fz * half), 2 * half);
}

export function terrainMode() {
  try {
    const p = new URLSearchParams(globalThis.location?.search || '');
    return p.get('terrain') === 'flat' ? 'flat' : 'real';
  } catch {
    return 'real';
  }
}

export async function loadTerrain(url = new URL('../assets/helsinki-terrain.bin', import.meta.url)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return setTerrain(decodeTerrain(await res.arrayBuffer()));
}
