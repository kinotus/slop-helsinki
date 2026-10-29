// js/helsinki-tiles.js — the City of Helsinki's textured 3D city model (kartta.hel.fi, 3D Tiles 1.1, glTF + KTX2),
// streamed around the camera.
//
// Tile content is glTF (y-up) placed in ECEF by translation-only tile transforms. Every vertex is converted exactly:
// ECEF -> WGS84 lon/lat/height -> the OSM geodata frame (HELSINKI_DATA.meta.lonLatAffine), with y = height. The model's
// heights are N2000 like the terrain (terrain.js), so buildings stand on the draped ground without any offset.
//
// Selection is screen-space-error driven with REPLACE refinement: a tile is replaced by its children only once all of
// them can be drawn, so nothing flickers away while finer levels stream in. Only buildings whose footprint centre lies in
// the simulated area are kept.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { HELSINKI_DATA } from './helsinki-geodata.js';

export const HELSINKI_TILESET_URL = 'https://kartta.hel.fi/3d/datasource-data/e5e7158a-52df-45a1-9be0-1be8f2828abd/tileset.json';

const WGS84_A = 6378137;
const WGS84_E2 = 0.00669437999014;
const WGS84_B = WGS84_A * Math.sqrt(1 - WGS84_E2);
const WGS84_EP2 = WGS84_E2 / (1 - WGS84_E2);
const DEG = 180 / Math.PI;

// ECEF (m) -> geodetic { lon, lat (degrees), h (m above the ellipsoid) } (Bowring; sub-millimetre at ground level).
export function ecefToGeodetic(x, y, z, out = {}) {
  const p = Math.hypot(x, y);
  const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const lat = Math.atan2(z + WGS84_EP2 * WGS84_B * st * st * st, p - WGS84_E2 * WGS84_A * ct * ct * ct);
  const sl = Math.sin(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  out.lon = Math.atan2(y, x) * DEG;
  out.lat = lat * DEG;
  out.h = Math.abs(lat) < 1.5 ? p / Math.cos(lat) - n : z / sl - n * (1 - WGS84_E2);
  return out;
}

export function geodeticToEcef(lon, lat, h = 0) {
  const lo = lon / DEG, la = lat / DEG, sl = Math.sin(la), cl = Math.cos(la);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  return [(n + h) * cl * Math.cos(lo), (n + h) * cl * Math.sin(lo), (n * (1 - WGS84_E2) + h) * sl];
}

// lon/lat (degrees) -> the geodata frame (x east, z south, metres).
export function makeProjection(affine = HELSINKI_DATA.meta.lonLatAffine) {
  const { lon0, lat0, x: ax, z: az } = affine;
  return {
    x: (lon, lat) => ax[0] + ax[1] * (lon - lon0) + ax[2] * (lat - lat0),
    z: (lon, lat) => az[0] + az[1] * (lon - lon0) + az[2] * (lat - lat0)
  };
}

// Column-major 4x4 helpers (plain arrays, double precision).
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiplyMat4(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}
const applyMat4 = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
// glTF is y-up; 3D Tiles is z-up: (x, y, z)_gltf -> (x, -z, y)
export const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

// Local-frame AABB of a 3D Tiles bounding volume (region in radians, or box / sphere under the tile's ECEF transform).
export function volumeBounds(volume, transform, projection) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const add = (lon, lat, h) => {
    const x = projection.x(lon, lat), z = projection.z(lon, lat);
    if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
    if (h < b.minY) b.minY = h; if (h > b.maxY) b.maxY = h;
  };
  if (volume.region) {
    const [w, s, e, n, h0, h1] = volume.region;
    for (const lon of [w, e]) for (const lat of [s, n]) { add(lon * DEG, lat * DEG, h0); add(lon * DEG, lat * DEG, h1); }
    return b;
  }
  const g = {};
  const corner = (x, y, z) => { const p = applyMat4(transform, x, y, z); ecefToGeodetic(p[0], p[1], p[2], g); add(g.lon, g.lat, g.h); };
  if (volume.box) {
    const [cx, cy, cz, ...h] = volume.box;
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) {
      corner(cx + i * h[0] + j * h[3] + k * h[6], cy + i * h[1] + j * h[4] + k * h[7], cz + i * h[2] + j * h[5] + k * h[8]);
    }
  } else if (volume.sphere) {
    const [cx, cy, cz, r] = volume.sphere;
    for (const i of [-1, 1]) for (const j of [-1, 1]) for (const k of [-1, 1]) corner(cx + i * r, cy + j * r, cz + k * r);
  }
  return b;
}

const overlaps = (b, area) => b.maxX >= area.minX && b.minX <= area.maxX && b.maxZ >= area.minZ && b.minZ <= area.maxZ;

let nextId = 0;
// Builds tile nodes for a tileset JSON's root (and, eagerly, its inline children). External tilesets referenced by
// content stay unloaded (tile.external = url) until the traversal needs them.
export function parseTile(json, parent, baseUrl, projection) {
  const transform = json.transform ? multiplyMat4(parent ? parent.transform : IDENTITY, json.transform) : (parent ? parent.transform : IDENTITY);
  const uri = json.content?.uri || json.content?.url;
  const url = uri ? new URL(uri, baseUrl).href : null;
  const external = url && /\.json(\?|$)/i.test(url) ? url : null;
  const tile = {
    id: nextId++,
    parent,
    depth: parent ? parent.depth + 1 : 0,
    geometricError: json.geometricError ?? 0,
    refine: (json.refine || parent?.refine || 'REPLACE').toUpperCase(),
    transform,
    bounds: volumeBounds(json.boundingVolume, transform, projection),
    contentUrl: external ? null : url,
    external,
    children: [],
    state: 'none',
    content: null,
    lastUsed: 0,
    loading: null
  };
  for (const child of json.children || []) tile.children.push(parseTile(child, tile, baseUrl, projection));
  return tile;
}

export function distanceToBounds(b, x, y, z) {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dy = Math.max(b.minY - y, 0, y - b.maxY);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.hypot(dx, dy, dz);
}

// Chooses the tiles to draw. `view` = { x, y, z, sseFactor (= screen height / (2 tan(fov / 2))), maxSse, area }.
// Returns { render: tiles to show (content ready), requests: tiles whose content or external tileset should load }.
export function selectTiles(root, view) {
  const render = [], requests = [];
  const visit = (tile) => {
    if (!overlaps(tile.bounds, view.area)) return { covered: true, list: [] };
    const distance = distanceToBounds(tile.bounds, view.x, view.y, view.z);
    tile.distance = distance;
    tile.lastUsed = view.frame;
    if (tile.external) {
      if (tile.state === 'ready') return visit(tile.children[0]);
      if (tile.state !== 'failed') requests.push(tile);
      return { covered: tile.state === 'failed', list: [] };
    }
    const sse = tile.geometricError * view.sseFactor / Math.max(distance, 1e-3);
    const hasContent = !!tile.contentUrl;
    const ready = hasContent && tile.state === 'ready';
    const failed = hasContent && tile.state === 'failed';
    const refine = tile.children.length > 0 && sse > view.maxSse;
    if (!refine) {
      if (!hasContent || failed) return { covered: true, list: [] };
      if (!ready) requests.push(tile);
      return { covered: ready, list: ready ? [tile] : [] };
    }
    const results = tile.children.map(visit);
    const childList = results.flatMap((r) => r.list);
    const childrenCovered = results.every((r) => r.covered);
    if (tile.refine === 'ADD') {
      if (hasContent && !ready && !failed) requests.push(tile);
      return { covered: childrenCovered && (!hasContent || ready || failed), list: ready ? [tile, ...childList] : childList };
    }
    if (childrenCovered) return { covered: true, list: childList };
    // Not all children are drawable yet: keep this tile in their place if it can be drawn (loading it if needed).
    if (hasContent && !failed) {
      if (!ready) requests.push(tile);
      else return { covered: true, list: [tile] };
    }
    return { covered: false, list: childList };
  };
  render.push(...visit(root).list);
  return { render, requests };
}

const _g = {};
// Bakes a parsed glTF scene into geometry in the local frame. `tileTransform` is the tile's ECEF transform; buildings
// (EXT_mesh_features feature ids) whose centre lies outside `area` are dropped.
export function bakeGltf(gltfScene, tileTransform, projection, area) {
  const meshes = [];
  gltfScene.updateMatrixWorld(true);
  const tileToEcef = multiplyMat4(tileTransform, Y_UP_TO_Z_UP);
  gltfScene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const src = o.geometry;
    const m = multiplyMat4(tileToEcef, o.matrixWorld.elements);
    const pos = src.attributes.position, nor = src.attributes.normal, uv = src.attributes.uv;
    const fid = src.attributes._feature_id_0;
    const count = pos.count;
    const positions = new Float32Array(count * 3);
    // East / up / south basis at the mesh's centre for the normals.
    const c = applyMat4(m, 0, 0, 0);
    ecefToGeodetic(c[0], c[1], c[2], _g);
    const lo = _g.lon / DEG, la = _g.lat / DEG;
    const E = [-Math.sin(lo), Math.cos(lo), 0];
    const U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const S = [Math.sin(la) * Math.cos(lo), Math.sin(la) * Math.sin(lo), -Math.cos(la)];
    for (let i = 0; i < count; i++) {
      const p = applyMat4(m, pos.getX(i), pos.getY(i), pos.getZ(i));
      ecefToGeodetic(p[0], p[1], p[2], _g);
      positions[i * 3] = projection.x(_g.lon, _g.lat);
      positions[i * 3 + 1] = _g.h;
      positions[i * 3 + 2] = projection.z(_g.lon, _g.lat);
    }
    let keepVertex = null;
    if (fid && area) {
      const sums = new Map();
      for (let i = 0; i < count; i++) {
        const f = Math.round(fid.getX(i));
        let s = sums.get(f);
        if (!s) sums.set(f, (s = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }));
        const x = positions[i * 3], z = positions[i * 3 + 2];
        if (x < s.minX) s.minX = x; if (x > s.maxX) s.maxX = x;
        if (z < s.minZ) s.minZ = z; if (z > s.maxZ) s.maxZ = z;
      }
      const inside = new Set();
      for (const [f, s] of sums) {
        const x = (s.minX + s.maxX) / 2, z = (s.minZ + s.maxZ) / 2;
        if (x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ) inside.add(f);
      }
      if (!inside.size) return;
      if (inside.size < sums.size) {
        keepVertex = new Uint8Array(count);
        for (let i = 0; i < count; i++) keepVertex[i] = inside.has(Math.round(fid.getX(i))) ? 1 : 0;
      }
    }
    const normals = new Float32Array(count * 3);
    if (nor) {
      for (let i = 0; i < count; i++) {
        const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
        const ex = m[0] * nx + m[4] * ny + m[8] * nz, ey = m[1] * nx + m[5] * ny + m[9] * nz, ez = m[2] * nx + m[6] * ny + m[10] * nz;
        let x = E[0] * ex + E[1] * ey + E[2] * ez, y = U[0] * ex + U[1] * ey + U[2] * ez, z = S[0] * ex + S[1] * ey + S[2] * ez;
        const l = Math.hypot(x, y, z) || 1;
        normals[i * 3] = x / l; normals[i * 3 + 1] = y / l; normals[i * 3 + 2] = z / l;
      }
    }
    let index = src.index ? Array.from(src.index.array) : Array.from({ length: count }, (_, i) => i);
    if (keepVertex) {
      const kept = [];
      for (let t = 0; t + 2 < index.length; t += 3) {
        if (keepVertex[index[t]] && keepVertex[index[t + 1]] && keepVertex[index[t + 2]]) kept.push(index[t], index[t + 1], index[t + 2]);
      }
      index = kept;
      if (!index.length) return;
    }
    // read per vertex: glTF attributes may be interleaved or normalized integers
    let uvs = null;
    if (uv) {
      uvs = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
    }
    // the y-up -> z-up -> east/up/south chain keeps handedness (z is south), so winding is preserved
    meshes.push({
      positions, normals: nor ? normals : null, uv: uvs,
      index: count > 65535 ? Uint32Array.from(index) : Uint16Array.from(index),
      material: o.material
    });
  });
  return meshes;
}

export function tilesMode() {
  try {
    const p = new URLSearchParams(globalThis.location?.search || '');
    return p.get('buildings') === 'osm' ? 'osm' : 'tiles';
  } catch {
    return 'tiles';
  }
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

// Starts streaming the city model into `scene`. Resolves once the root tileset is in (rejects if it can't be loaded,
// so the caller can fall back to the OSM extrusions).
export async function createHelsinkiTiles(scene, renderer, {
  url = HELSINKI_TILESET_URL, transcoderPath, maxSse = 16, concurrency = 6, maxLoaded = 700,
  area: areaOption, timeout = 15000
} = {}) {
  const projection = makeProjection();
  const [bx0, bz0, bx1, bz1] = HELSINKI_DATA.meta.bounds;
  const area = areaOption || { minX: bx0 - 60, minZ: bz0 - 60, maxX: bx1 + 60, maxZ: bz1 + 60 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let rootJson;
  try {
    rootJson = await fetchJson(url, controller.signal);
  } finally {
    clearTimeout(timer);
  }
  const root = parseTile(rootJson.root, null, url, projection);

  const ktx2 = new KTX2Loader();
  if (transcoderPath) ktx2.setTranscoderPath(transcoderPath);
  ktx2.detectSupport(renderer);
  const loader = new GLTFLoader().setKTX2Loader(ktx2);

  const group = new THREE.Group();
  group.name = 'HelsinkiBuildings3D';
  group.userData.noDrape = true;
  scene.add(group);

  const materials = new Map(); // shared MeshStandardMaterial per baseColor texture (one shader pipeline for all)
  const loaded = new Set();
  const queue = new Set();
  let active = 0;
  let frame = 0;
  let pending = 0;
  let disposed = false;
  const stats = { loaded: 0, failed: 0, triangles: 0, visible: 0 };

  function makeMaterial(src) {
    // untextured buildings come in a near-white grey that glares next to the photo-textured ones; give them a muted plaster tone
    const material = new THREE.MeshStandardMaterial({
      map: src.map || null, color: src.map ? 0xffffff : 0xa59d91,
      roughness: 0.92, metalness: 0, side: THREE.FrontSide
    });
    material.name = 'Helsinki3DModel';
    return material;
  }

  function buildContent(tile, meshes) {
    const content = new THREE.Group();
    content.name = `tile-${tile.depth}-${tile.id}`;
    content.visible = false;
    content.matrixAutoUpdate = false;
    let triangles = 0;
    for (const m of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
      if (m.uv) g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
      g.setIndex(new THREE.BufferAttribute(m.index, 1));
      if (!m.normals) g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const material = makeMaterial(m.material);
      materials.set(material, m.material);
      const mesh = new THREE.Mesh(g, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      content.add(mesh);
      triangles += m.index.length / 3;
    }
    content.userData.triangles = triangles;
    return content;
  }

  function disposeContent(tile) {
    const content = tile.content;
    if (!content) return;
    group.remove(content);
    content.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.dispose();
      o.material.map?.dispose();
      const src = materials.get(o.material);
      if (src) {
        src.map?.dispose();
        src.dispose();
        materials.delete(o.material);
      }
      o.material.dispose();
    });
    stats.triangles -= content.userData.triangles || 0;
    tile.content = null;
    tile.state = 'none';
    loaded.delete(tile);
  }

  async function load(tile) {
    active++;
    tile.state = 'loading';
    try {
      if (tile.external) {
        const json = await fetchJson(tile.external);
        if (disposed) return;
        tile.children = [parseTile(json.root, tile, tile.external, projection)];
        tile.state = 'ready';
      } else {
        const res = await fetch(tile.contentUrl);
        if (!res.ok) throw new Error(`${tile.contentUrl}: ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (disposed) return;
        const gltf = await loader.parseAsync(buffer, tile.contentUrl.replace(/[^/]*$/, ''));
        if (disposed) return;
        const meshes = bakeGltf(gltf.scene, tile.transform, projection, area);
        // the source geometry isn't needed any more; textures live on in the shared materials
        gltf.scene.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        tile.content = buildContent(tile, meshes);
        group.add(tile.content);
        tile.content.updateMatrixWorld(true);
        tile.state = 'ready';
        loaded.add(tile);
        stats.loaded++;
        stats.triangles += tile.content.userData.triangles;
      }
    } catch (e) {
      if (!disposed) {
        tile.state = 'failed';
        stats.failed++;
        console.warn('[helsinki-3d]', e.message || e);
      }
    } finally {
      active--;
    }
  }

  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const box = new THREE.Box3();
  let lastRender = [];

  function update(camera, screenHeight = renderer.domElement?.clientHeight || 900) {
    if (disposed) return;
    frame++;
    const fov = (camera.fov || 60) * Math.PI / 180;
    const p = camera.position;
    const { render, requests } = selectTiles(root, {
      x: p.x, y: p.y, z: p.z, frame, area, maxSse, sseFactor: screenHeight / (2 * Math.tan(fov / 2))
    });
    for (const t of lastRender) if (t.content) t.content.visible = false;
    for (const t of render) { t.content.visible = true; t.lastUsed = frame; }
    lastRender = render;
    stats.visible = render.length;

    // load the nearest requested tiles first, the ones in view before the rest
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const priority = (t) => {
      box.min.set(t.bounds.minX, t.bounds.minY, t.bounds.minZ);
      box.max.set(t.bounds.maxX, t.bounds.maxY, t.bounds.maxZ);
      return t.distance * (frustum.intersectsBox(box) ? 1 : 4) + (t.external ? -1e6 : 0);
    };
    queue.clear();
    for (const t of requests) if (t.state === 'none') queue.add(t);
    const ordered = [...queue].sort((a, b) => priority(a) - priority(b));
    pending = ordered.length;
    while (active < concurrency && ordered.length) load(ordered.shift());

    if (loaded.size > maxLoaded) {
      const visible = new Set(render);
      const evictable = [...loaded].filter((t) => !visible.has(t) && t.lastUsed < frame).sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of evictable.slice(0, loaded.size - maxLoaded)) disposeContent(t);
    }
  }

  // Streams until the view from `camera` is complete (or `timeout` ms pass): used behind the loading screen.
  async function preload(camera, { timeout: wait = 20000, onProgress } = {}) {
    const end = performance.now() + wait;
    for (;;) {
      update(camera);
      onProgress?.({ ...stats, pending, active });
      if (!pending && !active) return true;
      if (performance.now() > end) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function dispose() {
    disposed = true;
    for (const t of [...loaded]) disposeContent(t);
    scene.remove(group);
    ktx2.dispose();
  }

  return { group, root, update, preload, dispose, stats, get pending() { return pending + active; } };
}
