// js/terrain-drape.js — lays the flat-built static city onto the real terrain (terrain.js), once, after it is built.
//
// Every triangle of a static mesh is cut along the ground lattice's lines (x = kG, z = kG and x + z = kG), so each
// piece lies over one planar ground triangle; lifting the piece's corners by the ground height then keeps it exactly
// parallel to the ground (roads, kerbs, paint and lawns stay stacked at their few-centimetre offsets, nothing pokes
// through). Instanced props are lifted rigidly by the ground under each instance. The flat world's water surface
// (ISLAND_BOUNDS.waterLevel, below street level) maps to the sea level instead of following the ground.
import * as THREE from 'three/webgpu';
import { terrainSurface, surfaceHeight, SEA_LEVEL } from './terrain.js';

const EPS = 1e-9;

// Ground lift for a flat-world point: at or below the water surface (+ a margin for the bank walls' feet) things are
// moved to the sea level; above it they keep their height over the ground.
export function liftHeight(surface, waterLevel, x, y, z) {
  if (!surface) return y;
  if (y <= waterLevel + 0.06) return y - waterLevel + SEA_LEVEL;
  return y + surfaceHeight(surface, x, z);
}

// Scratch typed arrays by name, reused from one call to the next: take(name, Ctor, length, keep) returns the array of
// that name if it holds `length` items, otherwise a larger one with the first `keep` items copied over. Draping many
// meshes through one arena allocates its big work buffers once (fresh ones per mesh trigger costly full collections).
export function createArena() {
  const arrays = new Map();
  return (name, Ctor, length, keep = 0) => {
    const old = arrays.get(name);
    if (old && old.length >= length) return old;
    const grown = new Ctor(Math.max(length, old ? old.length * 2 : 0));
    if (old && keep) grown.set(old.subarray(0, keep));
    arrays.set(name, grown);
    return grown;
  };
}

// Clipping works on a pool of vertices (rows of `stride` numbers in one Float64Array, addressed by their offset) that is
// reused for every source triangle, so cutting allocates no per-vertex objects. clip(src, a, b, c, emit) cuts the
// triangle whose corners are the rows at offsets a, b, c of `src` and calls emit(pool, oa, ob, oc) for every piece;
// emit must copy what it keeps before the next clip.
//
// Triangles narrower than `minSize` in both x and z are passed through uncut: across a lattice line they bend by at
// most minSize times the ground's change of slope (a few centimetres), and skipping them spares the many tiny kerb,
// wall and trim triangles.
function createClipper(stride, surface, minSize = 0, take = createArena()) {
  const G = surface.cell;
  const FX = [1, 0, surface.minX, surface.maxX], FZ = [0, 1, surface.minZ, surface.maxZ];
  const FD = [1, 1, surface.minX + surface.minZ, surface.maxX + surface.maxZ];
  let pool = take('clip.pool', Float64Array, stride * 1024);
  let used = 0;
  let lo = 0, hi = 0;
  const vertex = () => {
    if (used + stride > pool.length) pool = take('clip.pool', Float64Array, pool.length * 2, used);
    const o = used;
    used += stride;
    return o;
  };
  const extent = (poly, ax, az) => {
    lo = Infinity; hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const f = ax * pool[poly[i]] + az * pool[poly[i] + 2];
      if (f < lo) lo = f;
      if (f > hi) hi = f;
    }
  };
  // Splits convex polygon `poly` (array of offsets) with the line ax * x + az * z = c. Returns [below, above]; either
  // may be null.
  const split = (poly, ax, az, c) => {
    const below = [], above = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[i + 1 === n ? 0 : i + 1];
      const dp = ax * pool[p] + az * pool[p + 2] - c, dq = ax * pool[q] + az * pool[q + 2] - c;
      if (dp <= EPS) below.push(p);
      if (dp >= -EPS) above.push(p);
      if ((dp < -EPS && dq > EPS) || (dp > EPS && dq < -EPS)) {
        const t = dp / (dp - dq);
        const v = vertex();
        for (let k = 0; k < stride; k++) pool[v + k] = pool[p + k] + (pool[q + k] - pool[p + k]) * t;
        below.push(v); above.push(v);
      }
    }
    return [below.length >= 3 ? below : null, above.length >= 3 ? above : null];
  };
  // split, but a polygon that doesn't straddle the line goes whole to its side (even if it lies on the line).
  const cut = (poly, ax, az, c) => {
    extent(poly, ax, az);
    if (hi <= c + EPS) return [poly, null];
    if (lo >= c - EPS) return [null, poly];
    return split(poly, ax, az, c);
  };
  // Cuts a polygon along the family's lines k * G strictly inside its extent (and within the lattice), into `out`.
  const slice = (poly, family, out) => {
    const ax = family[0], az = family[1];
    extent(poly, ax, az);
    const k0 = Math.max(Math.floor(lo / G + EPS) + 1, Math.ceil(family[2] / G));
    const k1 = Math.min(Math.ceil(hi / G - EPS) - 1, Math.floor(family[3] / G));
    let rest = poly;
    for (let k = k0; k <= k1 && rest; k++) {
      const [below, above] = split(rest, ax, az, k * G);
      if (below) out.push(below);
      rest = above;
    }
    if (rest) out.push(rest);
  };
  // whether a lattice line k * G of a family with bounds [min, max] lies strictly inside (l, h)
  const crosses = (l, h, min, max) =>
    Math.max(Math.floor(l / G + EPS) + 1, Math.ceil(min / G)) <= Math.min(Math.ceil(h / G - EPS) - 1, Math.floor(max / G));
  return {
    clip(src, a, b, c, emit) {
      used = 3 * stride;
      for (let k = 0; k < stride; k++) { pool[k] = src[a + k]; pool[stride + k] = src[b + k]; pool[2 * stride + k] = src[c + k]; }
      const x0 = pool[0], x1 = pool[stride], x2 = pool[2 * stride];
      const z0 = pool[2], z1 = pool[stride + 2], z2 = pool[2 * stride + 2];
      const xl = Math.min(x0, x1, x2), xh = Math.max(x0, x1, x2), zl = Math.min(z0, z1, z2), zh = Math.max(z0, z1, z2);
      if (minSize > 0 && xh - xl < minSize && zh - zl < minSize) { emit(pool, 0, stride, 2 * stride); return; }
      if (!crosses(xl, xh, FX[2], FX[3]) && !crosses(zl, zh, FZ[2], FZ[3]) &&
        !crosses(Math.min(x0 + z0, x1 + z1, x2 + z2), Math.max(x0 + z0, x1 + z1, x2 + z2), FD[2], FD[3])) {
        emit(pool, 0, stride, 2 * stride);
        return;
      }
      const tri = [0, stride, 2 * stride];
      // Beyond the lattice the ground is clamped to its edge, so it only varies along that edge: strips off the x sides
      // need only the z cuts, strips off the z sides only the x cuts, and the corners none.
      const pieces = [];
      let inner = null;
      const [left, restX] = cut(tri, 1, 0, FX[2]);
      if (left) slice(left, FZ, pieces);
      if (restX) {
        const [middle, right] = cut(restX, 1, 0, FX[3]);
        if (right) slice(right, FZ, pieces);
        if (middle) {
          const [bottom, restZ] = cut(middle, 0, 1, FZ[2]);
          if (bottom) slice(bottom, FX, pieces);
          if (restZ) {
            const [center, top] = cut(restZ, 0, 1, FZ[3]);
            if (top) slice(top, FX, pieces);
            inner = center;
          }
        }
      }
      if (inner) {
        let polys = [inner];
        for (let f = 0; f < 3; f++) {
          const family = f === 0 ? FX : f === 1 ? FZ : FD;
          const next = [];
          for (const poly of polys) slice(poly, family, next);
          polys = next;
        }
        for (const poly of polys) pieces.push(poly);
      }
      for (const poly of pieces) for (let i = 1; i + 1 < poly.length; i++) emit(pool, poly[0], poly[i], poly[i + 1]);
    }
  };
}

// Cuts triangle soup (vertices of `stride` components, x/y/z at 0/1/2) along the lattice lines of `surface`.
// Returns a new Float64Array of triangle soup with the same layout.
export function clipToLattice(soup, stride, surface, { minSize = 0 } = {}) {
  const clipper = createClipper(stride, surface, minSize);
  let written = 0;
  let buffer = new Float64Array(Math.max(soup.length, 1024));
  const emit = (buf, a, b, c) => {
    if (written + stride * 3 > buffer.length) {
      const grown = new Float64Array(buffer.length * 2);
      grown.set(buffer.subarray(0, written));
      buffer = grown;
    }
    for (const o of [a, b, c]) for (let k = 0; k < stride; k++) buffer[written++] = buf[o + k];
  };
  for (let t = 0; t < soup.length; t += stride * 3) clipper.clip(soup, t, t + stride, t + 2 * stride, emit);
  return buffer.slice(0, written);
}

// Collects vertices (rows of `stride` numbers at an offset in a Float64Array) into an indexed mesh, sharing identical
// ones (equal after rounding positions to 0.1 mm and other attributes to 1e-5), so clipped pieces that meet along
// lattice lines reuse their corners. Lookups go through a fixed-size, direct-mapped table of recent vertices: the clipper
// emits neighbouring pieces together, so nearly all shared corners are found while the table stays in cache; a corner
// that was evicted is simply stored twice.
export function createWelder(stride, capacity = 1024, tableBits = 16, take = createArena()) {
  let verts = take('weld.verts', Float64Array, capacity * stride);
  let keys = take('weld.keys', Int32Array, capacity * stride);
  let count = 0;
  let index = take('weld.index', Uint32Array, capacity * 3);
  let indexCount = 0;
  const table = take('weld.table', Int32Array, 1 << tableBits).fill(-1);
  const mask = (1 << tableBits) - 1;
  const q = take('weld.q', Int32Array, stride);
  const add = (buf, o) => {
    let h = 0x9e3779b9;
    for (let k = 0; k < stride; k++) {
      const x = buf[o + k] * (k < 3 ? 1e4 : 1e5);
      const n = (x + (x >= 0 ? 0.5 : -0.5)) | 0;
      q[k] = n;
      h = Math.imul(h ^ n, 0x85ebca6b);
      h ^= h >>> 13;
    }
    h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35);
    const slot = (h ^ (h >>> 16)) & mask;
    const i = table[slot];
    if (i !== -1) {
      let same = true;
      for (let k = 0, at = i * stride; k < stride; k++) if (keys[at + k] !== q[k]) { same = false; break; }
      if (same) return i;
    }
    if ((count + 1) * stride > verts.length) {
      verts = take('weld.verts', Float64Array, verts.length * 2, count * stride);
      keys = take('weld.keys', Int32Array, keys.length * 2, count * stride);
    }
    for (let k = 0, at = count * stride; k < stride; k++) { verts[at + k] = buf[o + k]; keys[at + k] = q[k]; }
    table[slot] = count;
    return count++;
  };
  return {
    triangle(buf, a, b, c) {
      if (indexCount + 3 > index.length) index = take('weld.index', Uint32Array, index.length * 2, indexCount);
      index[indexCount++] = add(buf, a); index[indexCount++] = add(buf, b); index[indexCount++] = add(buf, c);
    },
    get indexCount() { return indexCount; },
    finish: () => ({ vertices: verts.subarray(0, count * stride), count, index: index.subarray(0, indexCount) })
  };
}

// Collects the clipped pieces of horizontal triangles per lattice triangle (and height and facing). flush() passes every
// lattice triangle that its pieces tile exactly, with all their attributes following one affine map, to `out` as a
// single triangle, and all other pieces unchanged (out(buffer, oa, ob, oc) as for the clipper). Large flat layers (land,
// water, lawns) are earcut into long slivers that cut every lattice triangle several times; this puts their interiors
// back at one triangle per lattice triangle.
export function createCoalescer(stride, surface, out, take = createArena()) {
  const G = surface.cell, full = G * G / 2, S3 = stride * 3;
  let buf = take('merge.buf', Float64Array, S3 * 1024);
  let keys = take('merge.keys', Float64Array, 1024);
  let n = 0;
  const layers = new Map();
  const scratch = take('merge.scratch', Float64Array, S3);
  const area2 = (b, o) => (b[o + stride] - b[o]) * (b[o + 2 * stride + 2] - b[o + 2]) - (b[o + 2 * stride] - b[o]) * (b[o + stride + 2] - b[o + 2]);
  return {
    add(src, a, b, c) {
      const fx = (src[a] + src[b] + src[c]) / 3 / G - surface.i0, fz = (src[a + 2] + src[b + 2] + src[c + 2]) / 3 / G - surface.j0;
      if (!(fx > 0 && fz > 0 && fx < surface.nx - 1 && fz < surface.nz - 1)) { out(src, a, b, c); return; }
      const i = Math.floor(fx), j = Math.floor(fz);
      const facing = (src[b] - src[a]) * (src[c + 2] - src[a + 2]) - (src[c] - src[a]) * (src[b + 2] - src[a + 2]) > 0 ? 1 : 0;
      const layerKey = Math.round(src[a + 1] * 1e4) * 2 + facing;
      let layer = layers.get(layerKey);
      if (layer === undefined) {
        if (layers.size >= 4096) { out(src, a, b, c); return; }
        layers.set(layerKey, layer = layers.size);
      }
      if (n >= keys.length) keys = take('merge.keys', Float64Array, keys.length * 2, n);
      if ((n + 1) * S3 > buf.length) buf = take('merge.buf', Float64Array, buf.length * 2, n * S3);
      keys[n] = ((j * surface.nx + i) * 2 + (fx - i + fz - j > 1 ? 1 : 0)) * 4096 + layer;
      const o = n * S3;
      for (let k = 0; k < stride; k++) { buf[o + k] = src[a + k]; buf[o + stride + k] = src[b + k]; buf[o + 2 * stride + k] = src[c + k]; }
      n++;
    },
    flush() {
      const bucketOf = new Map();
      const bucket = take('merge.bucket', Int32Array, n), area = take('merge.area', Float64Array, n);
      const ref = take('merge.ref', Int32Array, n), refArea = take('merge.refArea', Float64Array, n);
      const state = take('merge.state', Uint8Array, n); // 1: tiled exactly, 3: attributes not affine, 5: emitted
      let buckets = 0;
      for (let p = 0; p < n; p++) {
        let b = bucketOf.get(keys[p]);
        if (b === undefined) { bucketOf.set(keys[p], b = buckets++); refArea[b] = -1; area[b] = 0; state[b] = 0; }
        bucket[p] = b;
        const a = Math.abs(area2(buf, p * S3)) / 2;
        area[b] += a;
        if (a > refArea[b]) { refArea[b] = a; ref[b] = p; }
      }
      for (let b = 0; b < buckets; b++) if (Math.abs(area[b] - full) < full * 1e-6) state[b] = 1;
      // affine interpolation of component k at (x, z) from the bucket's largest piece
      const interp = (b, x, z, k) => {
        const o = ref[b] * S3, x0 = buf[o], z0 = buf[o + 2];
        const x1 = buf[o + stride] - x0, z1 = buf[o + stride + 2] - z0, x2 = buf[o + 2 * stride] - x0, z2 = buf[o + 2 * stride + 2] - z0;
        const d = x1 * z2 - x2 * z1, dx = x - x0, dz = z - z0;
        const l1 = (dx * z2 - x2 * dz) / d, l2 = (x1 * dz - dx * z1) / d;
        return buf[o + k] + l1 * (buf[o + stride + k] - buf[o + k]) + l2 * (buf[o + 2 * stride + k] - buf[o + k]);
      };
      for (let p = 0; p < n; p++) {
        const b = bucket[p];
        if (state[b] !== 1 || p === ref[b]) continue;
        for (let o = p * S3, end = o + S3; o < end && state[b] === 1; o += stride) {
          for (let k = 3; k < stride; k++) {
            const want = buf[o + k];
            if (Math.abs(interp(b, buf[o], buf[o + 2], k) - want) > 1e-4 * (1 + Math.abs(want))) { state[b] = 3; break; }
          }
        }
      }
      let merged = 0;
      for (let p = 0; p < n; p++) {
        const b = bucket[p];
        if (state[b] !== 1 && state[b] !== 5) { out(buf, p * S3, p * S3 + stride, p * S3 + 2 * stride); continue; }
        if (state[b] === 5) continue;
        state[b] = 5;
        merged++;
        const cellKey = Math.floor(keys[p] / 4096), upper = cellKey % 2, cell = (cellKey - upper) / 2;
        const i = cell % surface.nx, j = (cell - i) / surface.nx;
        const x0 = (surface.i0 + i) * G, z0 = (surface.j0 + j) * G;
        const corners = upper ? [x0 + G, z0 + G, x0, z0 + G, x0 + G, z0] : [x0, z0, x0 + G, z0, x0, z0 + G];
        const flip = area2(buf, ref[b] * S3) < 0;
        const y = buf[ref[b] * S3 + 1];
        for (let v = 0; v < 3; v++) {
          const x = corners[v * 2], z = corners[v * 2 + 1], o = (flip ? 2 - v : v) * stride;
          scratch[o] = x; scratch[o + 1] = y; scratch[o + 2] = z;
          for (let k = 3; k < stride; k++) scratch[o + k] = interp(b, x, z, k);
        }
        out(scratch, 0, stride, 2 * stride);
      }
      n = 0;
      layers.clear();
      return { buckets, merged };
    }
  };
}

const attributeComponent = (attr, i, c) => (c === 0 ? attr.getX(i) : c === 1 ? attr.getY(i) : c === 2 ? attr.getZ(i) : attr.getW(i));

// Drapes one static (non-instanced) mesh, line or points: its geometry is replaced by a lifted copy in the same local
// frame. Triangle meshes are clipped along the lattice (unless clip is false) and come out indexed.
export function drapeMesh(mesh, surface, waterLevel, { clip = true, minSize = 1, take = createArena() } = {}) {
  const src = mesh.geometry;
  const pos = src.attributes.position;
  if (!pos) return 0;
  mesh.updateMatrixWorld();
  const world = mesh.matrixWorld;
  const inverse = world.clone().invert();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(world);
  const inverseNormal = new THREE.Matrix3().getNormalMatrix(inverse);
  const names = Object.keys(src.attributes).filter((n) => !src.attributes[n].isInstancedBufferAttribute);
  // position first, then normal, then everything else
  names.sort((a, b) => (a === 'position' ? -1 : b === 'position' ? 1 : a === 'normal' ? -1 : b === 'normal' ? 1 : 0));
  const sizes = names.map((n) => src.attributes[n].itemSize);
  const stride = sizes.reduce((s, n) => s + n, 0);
  const index = src.index;
  const groups = src.groups.length ? src.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
  const v = new THREE.Vector3();
  // Reads source vertex i into `row` at offset `o`, position and normal in world space.
  const read = (i, row, o) => {
    for (let a = 0; a < names.length; a++) {
      const attr = src.attributes[names[a]];
      if (names[a] === 'position') {
        v.fromBufferAttribute(attr, i).applyMatrix4(world);
        row[o] = v.x; row[o + 1] = v.y; row[o + 2] = v.z;
      } else if (names[a] === 'normal') {
        v.fromBufferAttribute(attr, i).applyMatrix3(normalMatrix);
        row[o] = v.x; row[o + 1] = v.y; row[o + 2] = v.z;
      } else {
        for (let c = 0; c < sizes[a]; c++) row[o + c] = attributeComponent(attr, i, c);
      }
      o += sizes[a];
    }
  };
  const ranges = [];
  let rows, total, outIndex = null;
  if (mesh.isMesh) {
    const welder = createWelder(stride, Math.max(1024, pos.count * 2), 16, take);
    const clipper = createClipper(stride, surface, minSize, take);
    const tri = new Float64Array(stride * 3);
    const emit = (buf, a, b, c) => welder.triangle(buf, a, b, c);
    const coalescer = createCoalescer(stride, surface, emit, take);
    const flatEmit = (buf, a, b, c) => coalescer.add(buf, a, b, c);
    const hasNormal = names[1] === 'normal';
    const horizontal = () => {
      if (Math.abs(tri[1] - tri[stride + 1]) > 1e-6 || Math.abs(tri[1] - tri[2 * stride + 1]) > 1e-6) return false;
      if (hasNormal) {
        for (let o = 0; o < 3 * stride; o += stride) {
          if (Math.abs(tri[o + 4]) < 0.9999 * Math.hypot(tri[o + 3], tri[o + 4], tri[o + 5])) return false;
        }
      }
      return true;
    };
    for (const g of groups) {
      const end = Math.min(g.start + g.count, index ? index.count : pos.count);
      const first = welder.indexCount;
      for (let k = g.start; k + 2 < end; k += 3) {
        for (let c = 0; c < 3; c++) read(index ? index.getX(k + c) : k + c, tri, c * stride);
        if (clip) clipper.clip(tri, 0, stride, 2 * stride, horizontal() ? flatEmit : emit);
        else emit(tri, 0, stride, 2 * stride);
      }
      coalescer.flush();
      ranges.push([first, welder.indexCount - first, g.materialIndex]);
    }
    const welded = welder.finish();
    rows = welded.vertices; total = welded.count; outIndex = welded.index;
  } else {
    total = 0;
    for (const g of groups) total += Math.max(0, Math.min(g.start + g.count, index ? index.count : pos.count) - g.start);
    rows = new Float64Array(total * stride);
    let vertex = 0;
    for (const g of groups) {
      const end = Math.min(g.start + g.count, index ? index.count : pos.count);
      const first = vertex;
      for (let k = g.start; k < end; k++, vertex++) read(index ? index.getX(k) : k, rows, vertex * stride);
      ranges.push([first, vertex - first, g.materialIndex]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  const arrays = names.map((n, a) => {
    const attr = src.attributes[n];
    const Ctor = attr.array.constructor;
    return new Ctor(total * sizes[a]);
  });
  const hasNormal = names[1] === 'normal';
  const G = surface.cell;
  const soup = rows;
  for (let o = 0, vertex = 0; vertex < total; o += stride, vertex++) {
    const x = soup[o], y = soup[o + 1], z = soup[o + 2];
    const ly = liftHeight(surface, waterLevel, x, y, z);
    v.set(x, ly, z).applyMatrix4(inverse);
    arrays[0][vertex * 3] = v.x; arrays[0][vertex * 3 + 1] = v.y; arrays[0][vertex * 3 + 2] = v.z;
    let off = sizes[0];
    if (hasNormal) {
      // y' = y + h(x, z) is a shear; normals transform with its inverse transpose: n - n.y * grad h
      let nx = soup[o + 3], ny = soup[o + 4], nz = soup[o + 5];
      if (y > waterLevel + 0.06) {
        const gx = (surfaceHeight(surface, x + G * 0.5, z) - surfaceHeight(surface, x - G * 0.5, z)) / G;
        const gz = (surfaceHeight(surface, x, z + G * 0.5) - surfaceHeight(surface, x, z - G * 0.5)) / G;
        nx -= gx * ny; nz -= gz * ny;
      }
      v.set(nx, ny, nz).applyMatrix3(inverseNormal).normalize();
      arrays[1][vertex * 3] = v.x; arrays[1][vertex * 3 + 1] = v.y; arrays[1][vertex * 3 + 2] = v.z;
      off += 3;
    }
    for (let a = hasNormal ? 2 : 1; a < names.length; a++) {
      const s = sizes[a], arr = arrays[a], integer = !(arr instanceof Float32Array || arr instanceof Float64Array);
      for (let c = 0; c < s; c++) arr[vertex * s + c] = integer ? Math.round(soup[o + off + c]) : soup[o + off + c];
      off += s;
    }
  }
  if (outIndex) geometry.setIndex(new THREE.BufferAttribute(total > 65535 ? outIndex.slice() : Uint16Array.from(outIndex), 1));
  if (src.groups.length) for (const [start, count, materialIndex] of ranges) geometry.addGroup(start, count, materialIndex);
  names.forEach((n, a) => {
    const attr = src.attributes[n];
    geometry.setAttribute(n, new THREE.BufferAttribute(arrays[a], sizes[a], attr.normalized));
  });
  geometry.userData = { ...src.userData, draped: true };
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  mesh.geometry = geometry;
  return total;
}

const _m = new THREE.Matrix4();
const _w = new THREE.Matrix4();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();

// Lifts every instance of an instanced mesh by the ground under its origin.
export function drapeInstances(mesh, surface, waterLevel) {
  mesh.updateMatrixWorld();
  const inverse3 = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld.clone().invert());
  const arr = mesh.instanceMatrix.array;
  for (let i = 0; i < mesh.instanceMatrix.count; i++) {
    _m.fromArray(arr, i * 16);
    _w.multiplyMatrices(mesh.matrixWorld, _m);
    _t.setFromMatrixPosition(_w);
    const dy = liftHeight(surface, waterLevel, _t.x, _t.y, _t.z) - _t.y;
    if (dy === 0) continue;
    // world offset (0, dy, 0) expressed in the mesh's local frame
    _d.set(0, dy, 0).applyMatrix3(inverse3);
    arr[i * 16 + 12] += _d.x; arr[i * 16 + 13] += _d.y; arr[i * 16 + 14] += _d.z;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.boundingSphere) mesh.computeBoundingSphere();
  if (mesh.boundingBox) mesh.computeBoundingBox();
}

// Drapes the static objects under `roots` (meshes, instanced meshes, lights, points and lines). Objects (or their
// ancestors) flagged userData.noDrape are left alone. Returns { meshes, instanced, vertices }.
export function drapeStatic(roots, { waterLevel, clip = true } = {}) {
  const surface = terrainSurface();
  const stats = { meshes: 0, instanced: 0, lights: 0, vertices: 0 };
  if (!surface) return stats;
  const geometryUsers = new Map();
  const take = createArena();
  const visit = (o, fn) => { if (o.userData?.noDrape) return; fn(o); for (const c of o.children) visit(c, fn); };
  for (const r of roots) visit(r, (o) => { if (o.isMesh && !o.isInstancedMesh) geometryUsers.set(o.geometry, (geometryUsers.get(o.geometry) || 0) + 1); });
  for (const r of roots) r.updateMatrixWorld(true);
  for (const r of roots) visit(r, (o) => {
    if (o.isInstancedMesh) { drapeInstances(o, surface, waterLevel); stats.instanced++; return; }
    if (o.isLight) {
      o.updateMatrixWorld();
      _t.setFromMatrixPosition(o.matrixWorld);
      o.position.y += liftHeight(surface, waterLevel, _t.x, _t.y, _t.z) - _t.y;
      if (o.target && !o.target.parent) {
        const tp = o.target.position;
        tp.y = liftHeight(surface, waterLevel, tp.x, tp.y, tp.z);
        o.target.updateMatrixWorld();
      }
      stats.lights++;
      return;
    }
    if (o.isMesh || o.isPoints || o.isLine) {
      if (geometryUsers.get(o.geometry) > 1) o.geometry = o.geometry.clone();
      stats.vertices += drapeMesh(o, surface, waterLevel, { clip: clip && o.isMesh && !o.isLine, take });
      stats.meshes++;
    }
  });
  for (const r of roots) r.updateMatrixWorld(true);
  return stats;
}

// Moves flat-world colliders ({minX, maxX, minZ, maxZ, minY?, maxY}) up onto the ground: their floor goes to the lowest
// ground under their footprint and their top keeps its height above the highest.
export function liftColliders(colliders, waterLevel) {
  const surface = terrainSurface();
  if (!surface) return;
  for (const c of colliders) {
    if (c._lifted) continue;
    const xs = [c.minX, (c.minX + c.maxX) / 2, c.maxX], zs = [c.minZ, (c.minZ + c.maxZ) / 2, c.maxZ];
    let lo = Infinity, hi = -Infinity;
    for (const x of xs) for (const z of zs) {
      const g = surfaceHeight(surface, x, z);
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const minY = c.minY ?? 0;
    c.minY = minY <= waterLevel ? minY : minY + lo;
    if (Number.isFinite(c.maxY)) c.maxY += hi;
    c._lifted = true;
  }
}
