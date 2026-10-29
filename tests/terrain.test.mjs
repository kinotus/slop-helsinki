import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as terrain from '../js/terrain.js';
import { createGrid, encodeGrid } from '../tools/build-helsinki-terrain.mjs';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const drape = loadModule(readFileSync(new URL('../js/terrain-drape.js', import.meta.url), 'utf8'), {
  imports: { 'three/webgpu': { Matrix4: class {}, Vector3: class {}, Matrix3: class {} }, './terrain.js': terrain },
  filename: 'terrain-drape.js'
});

function syntheticRaster() {
  const nx = 40, nz = 30, cell = 2, minX = -37, minZ = -25;
  const heights = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const x = minX + i * cell, z = minZ + j * cell;
    heights[j * nx + i] = 5 + 0.1 * x - 0.05 * z + 2 * Math.sin(x / 7) * Math.cos(z / 5);
  }
  return { minX, minZ, cell, nx, nz, heights };
}

test('the baked terrain grid round-trips through the binary format', () => {
  const grid = createGrid(-10, -8, 10, 6, 2);
  grid.heights.forEach((_, k) => { grid.heights[k] = 0.2 + (k % 97) * 0.31; });
  const decoded = terrain.decodeTerrain(encodeGrid(grid));
  assert.equal(decoded.nx, grid.nx);
  assert.equal(decoded.nz, grid.nz);
  assert.equal(decoded.cell, grid.cell);
  assert.ok(Math.abs(decoded.minX - grid.minX) < 1e-6);
  for (let k = 0; k < grid.heights.length; k++) assert.ok(Math.abs(decoded.heights[k] - grid.heights[k]) <= 0.006, `height ${k}`);
});

test('the shipped Helsinki terrain is in range and puts Senaatintori above the harbour', () => {
  const raster = terrain.decodeTerrain(readFileSync(new URL('../assets/helsinki-terrain.bin', import.meta.url)));
  assert.ok(raster.minX < -1500 && raster.minZ < -1160);
  assert.ok(raster.minX + raster.cell * (raster.nx - 1) > 700);
  const senate = terrain.sampleRaster(raster, 0, 0), market = terrain.sampleRaster(raster, 44, 223);
  assert.ok(senate > 5 && senate < 12, `Senaatintori ${senate}`);
  assert.ok(market > 0 && market < 4, `Kauppatori ${market}`);
});

test('groundAt is flat without terrain and piecewise linear over the lattice triangles with it', () => {
  terrain.setTerrain(null);
  assert.equal(terrain.groundAt(12, 34), 0);
  assert.equal(terrain.terrainEnabled(), false);
  const s = terrain.setTerrain(syntheticRaster(), 6);
  assert.equal(terrain.terrainEnabled(), true);
  const node = (i, j) => s.heights[(j - s.j0) * s.nx + (i - s.i0)];
  // exact at nodes
  assert.ok(Math.abs(terrain.groundAt(6, 0) - node(1, 0)) < 1e-6);
  // linear inside the lower-left triangle of a cell (u + v <= 1)
  const g = (u, v) => terrain.groundAt(-6 + 6 * u, -6 + 6 * v);
  const expected = node(-1, -1) + (node(0, -1) - node(-1, -1)) * 0.3 + (node(-1, 0) - node(-1, -1)) * 0.5;
  assert.ok(Math.abs(g(0.3, 0.5) - expected) < 1e-5);
  // continuous across the diagonal
  assert.ok(Math.abs(g(0.5 - 1e-7, 0.5) - g(0.5 + 1e-7, 0.5)) < 1e-4);
  const n = terrain.groundNormal(-3, -3);
  assert.ok(Math.abs(Math.hypot(n.x, n.y, n.z) - 1) < 1e-9 && n.y > 0.5);
  terrain.setTerrain(null);
});

test('clipping cuts triangles along the lattice so lifted pieces lie on the ground', () => {
  const s = terrain.setTerrain(syntheticRaster(), 6);
  // one large triangle, plus a uv attribute (stride 5: x y z u v)
  const soup = new Float64Array([-20, 0.1, -15, 0, 0, 25, 0.1, -10, 1, 0, -5, 0.1, 18, 0, 1]);
  const out = drape.clipToLattice(soup, 5, s);
  assert.ok(out.length / 15 > 20, 'the triangle is cut into many pieces');
  let area = 0;
  for (let t = 0; t < out.length; t += 15) {
    const ax = out[t], az = out[t + 2], bx = out[t + 5], bz = out[t + 7], cx = out[t + 10], cz = out[t + 12];
    area += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    // every piece's centroid, lifted, equals the interpolated lift of its corners (it lies within one ground triangle)
    const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
    const lifted = (terrain.surfaceHeight(s, ax, az) + terrain.surfaceHeight(s, bx, bz) + terrain.surfaceHeight(s, cx, cz)) / 3;
    assert.ok(Math.abs(terrain.surfaceHeight(s, mx, mz) - lifted) < 1e-6, `piece ${t / 15} is planar on the ground`);
    // attributes stay consistent with position (u was laid out linearly in x/z over the source triangle)
    for (const o of [t, t + 5, t + 10]) assert.ok(out[o + 3] >= -1e-9 && out[o + 3] <= 1 + 1e-9);
  }
  assert.ok(Math.abs(area - 0.5 * Math.abs(45 * 33 - 15 * 5)) < 1e-6, 'area is preserved');
  // a triangle reaching far beyond the lattice: outside it only the cuts the clamped ground needs are made
  const far = drape.clipToLattice(new Float64Array([-10, 0.1, -5, 0, 0, 900, 0.1, 10, 1, 0, 0, 0.1, 800, 0, 1]), 5, s);
  let farArea = 0, outside = 0;
  for (let t = 0; t < far.length; t += 15) {
    const ax = far[t], az = far[t + 2], bx = far[t + 5], bz = far[t + 7], cx = far[t + 10], cz = far[t + 12];
    farArea += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
    const mx = (ax + bx + cx) / 3, mz = (az + bz + cz) / 3;
    if (mx > s.maxX || mz > s.maxZ) outside++;
    const lifted = (terrain.surfaceHeight(s, ax, az) + terrain.surfaceHeight(s, bx, bz) + terrain.surfaceHeight(s, cx, cz)) / 3;
    assert.ok(Math.abs(terrain.surfaceHeight(s, mx, mz) - lifted) < 1e-6, `far piece ${t / 15} is planar on the clamped ground`);
  }
  assert.ok(Math.abs(farArea - 0.5 * Math.abs(910 * 805 - 10 * 15)) < 1e-4, 'far area is preserved');
  assert.ok(outside < 60, `${outside} pieces outside the lattice`);
  terrain.setTerrain(null);
});

test('small triangles can skip clipping and the welder shares corners of neighbouring pieces', () => {
  const s = terrain.setTerrain(syntheticRaster(), 6);
  const small = new Float64Array([5.7, 0, 5.7, 0, 0, 6.3, 0, 5.7, 1, 0, 5.7, 0, 6.3, 0, 1]);
  assert.ok(drape.clipToLattice(small, 5, s).length > 15, 'cut when no size limit is given');
  assert.equal(drape.clipToLattice(small, 5, s, { minSize: 1 }).length, 15, 'left whole below minSize');
  const soup = drape.clipToLattice(new Float64Array([-20, 0.1, -15, 0, 0, 25, 0.1, -10, 1, 0, -5, 0.1, 18, 0, 1]), 5, s);
  const welder = drape.createWelder(5, 4);
  for (let t = 0; t < soup.length; t += 15) welder.triangle(soup, t, t + 5, t + 10);
  const { vertices, count, index } = welder.finish();
  assert.equal(index.length, soup.length / 5);
  assert.ok(count < index.length / 2, `${count} shared vertices for ${index.length / 3} pieces`);
  for (let k = 0; k < index.length; k++) {
    for (let c = 0; c < 5; c++) assert.ok(Math.abs(vertices[index[k] * 5 + c] - soup[k * 5 + c]) < 1e-4, `vertex ${k}`);
  }
  terrain.setTerrain(null);
});

test('pieces of flat triangles that tile a lattice triangle are coalesced back into it', () => {
  const s = terrain.setTerrain(syntheticRaster(), 6);
  const V = (x, z) => [x, 0.05, z, x / 10, z / 10];
  // a lattice-aligned 24 m square as two triangles plus a sliver fan, so every cell is cut by the diagonal and slivers
  const tris = [[V(-12, -12), V(12, -12), V(12, 12)], [V(-12, -12), V(12, 12), V(-7, 12)], [V(-12, -12), V(-7, 12), V(-12, 12)]];
  const out = [];
  const coalescer = drape.createCoalescer(5, s, (buf, a, b, c) => out.push([a, b, c].map((o) => Array.from(buf.subarray(o, o + 5)))));
  for (const t of tris) {
    const pieces = drape.clipToLattice(new Float64Array(t.flat()), 5, s);
    for (let o = 0; o < pieces.length; o += 15) coalescer.add(pieces, o, o + 5, o + 10);
  }
  const stats = coalescer.flush();
  assert.equal(stats.merged, 32);
  assert.equal(out.length, 32, 'one triangle per lattice triangle of the 4 x 4 cells');
  let area = 0;
  for (const [a, b, c] of out) {
    const a2 = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    assert.ok(a2 > 0, 'winding is kept');
    area += a2 / 2;
    for (const v of [a, b, c]) {
      assert.ok(Math.abs(v[3] - v[0] / 10) < 1e-9 && Math.abs(v[4] - v[2] / 10) < 1e-9, 'attributes follow the affine map');
      assert.equal(v[1], 0.05);
    }
  }
  assert.ok(Math.abs(area - 24 * 24) < 1e-6);
  terrain.setTerrain(null);
});

test('the water surface maps to sea level while land follows the ground', () => {
  const s = terrain.setTerrain(syntheticRaster(), 6);
  assert.equal(drape.liftHeight(s, -2.2, 3, -2.2, 4), terrain.SEA_LEVEL);
  assert.ok(Math.abs(drape.liftHeight(s, -2.2, 3, 0.22, 4) - (0.22 + terrain.groundAt(3, 4))) < 1e-9);
  const colliders = [{ minX: -4, maxX: 4, minZ: -2, maxZ: 2, maxY: 10 }];
  drape.liftColliders(colliders, -2.2);
  assert.ok(colliders[0].minY > 0 && colliders[0].maxY > 10);
  drape.liftColliders(colliders, -2.2);
  assert.ok(colliders[0].maxY < 30, 'lifting twice is a no-op');
  terrain.setTerrain(null);
});
