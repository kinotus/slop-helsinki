import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { HELSINKI_DATA } from '../js/helsinki-geodata.js';

const require = createRequire(import.meta.url);
const { loadModule } = require('./helpers/module.cjs');
const tiles = loadModule(readFileSync(new URL('../js/helsinki-tiles.js', import.meta.url), 'utf8'), {
  imports: {
    'three/webgpu': {},
    'three/addons/loaders/GLTFLoader.js': {},
    'three/addons/loaders/KTX2Loader.js': {},
    './helsinki-geodata.js': { HELSINKI_DATA }
  },
  globals: { URL },
  filename: 'helsinki-tiles.js'
});

const near = (a, b, eps, label) => assert.ok(Math.abs(a - b) <= eps, `${label}: ${a} vs ${b}`);

test('ECEF converts back to the geodata frame exactly, with the height as y', () => {
  const { lon0, lat0 } = HELSINKI_DATA.meta.lonLatAffine;
  const projection = tiles.makeProjection();
  const g = tiles.ecefToGeodetic(...tiles.geodeticToEcef(lon0, lat0, 8.2));
  near(g.lon, lon0, 1e-10, 'lon');
  near(g.lat, lat0, 1e-10, 'lat');
  near(g.h, 8.2, 1e-4, 'h');
  near(projection.x(g.lon, g.lat), 0, 1e-4, 'Senaatintori x');
  near(projection.z(g.lon, g.lat), 0, 1e-4, 'Senaatintori z');
  // 1 km east and north land where the OSM affine puts them
  const e = tiles.ecefToGeodetic(...tiles.geodeticToEcef(lon0 + 1000 / 55374.3027, lat0 + 1000 / 111319.4908, 30));
  near(projection.x(e.lon, e.lat), 1000, 1e-3, 'east');
  near(projection.z(e.lon, e.lat), -1000, 1e-3, 'north');
  near(e.h, 30, 1e-4, 'height');
});

test('the y-up to z-up glTF axis swap is a proper rotation', () => {
  const m = tiles.Y_UP_TO_Z_UP;
  // (x, y, z)_gltf -> (x, -z, y)
  const apply = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  assert.deepEqual(apply(1, 2, 3), [1, -3, 2]);
  const t = tiles.multiplyMat4([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1], m);
  assert.deepEqual([t[12], t[13], t[14]], [10, 20, 30]);
});

test('baked tiles read interleaved glTF uvs per vertex', () => {
  const { lon0, lat0 } = HELSINKI_DATA.meta.lonLatAffine;
  const [ex, ey, ez] = tiles.geodeticToEcef(lon0, lat0, 10);
  const attr = (array, itemSize, offset = 0, stride = itemSize) => ({
    array, itemSize, count: array.length / stride,
    getX: (i) => array[i * stride + offset], getY: (i) => array[i * stride + offset + 1], getZ: (i) => array[i * stride + offset + 2]
  });
  // three vertices, interleaved as [u, v, pad, pad]
  const uv = attr(new Float32Array([0.1, 0.2, 9, 9, 0.3, 0.4, 9, 9, 0.5, 0.6, 9, 9]), 2, 0, 4);
  const mesh = {
    isMesh: true, material: {}, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    geometry: { attributes: { position: attr(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3), uv }, index: null }
  };
  const scene = { updateMatrixWorld() {}, traverse: (fn) => fn(mesh) };
  const [baked] = tiles.bakeGltf(scene, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ex, ey, ez, 1], tiles.makeProjection(), null);
  assert.deepEqual([...baked.uv].map((n) => Math.round(n * 10) / 10), [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
  near(baked.positions[0], 0, 1e-3, 'x');
  near(baked.positions[1], 10, 1e-3, 'height');
  near(baked.positions[2], 0, 1e-3, 'z');
});

function region(x0, z0, x1, z1) {
  const { lon0, lat0 } = HELSINKI_DATA.meta.lonLatAffine;
  const rad = Math.PI / 180;
  const lon = (x) => (lon0 + x / 55374.3027) * rad, lat = (z) => (lat0 - z / 111319.4908) * rad;
  return { region: [lon(x0), lat(z1), lon(x1), lat(z0), 0, 40] };
}

function quadTree() {
  // root (ge 40) -> 4 children (ge 10) with content, over a 400 m square around the origin
  const children = [];
  for (const [x, z] of [[-200, -200], [0, -200], [-200, 0], [0, 0]]) {
    children.push({ boundingVolume: region(x, z, x + 200, z + 200), geometricError: 0, content: { uri: `c/${x}_${z}.glb` } });
  }
  return { boundingVolume: region(-200, -200, 200, 200), geometricError: 40, refine: 'REPLACE', content: { uri: 'root.glb' }, children };
}

test('selection refines by screen-space error and keeps the parent until all children are ready', () => {
  const projection = tiles.makeProjection();
  const root = tiles.parseTile(quadTree(), null, 'https://example.test/tiles/tileset.json', projection);
  near(root.bounds.minX, -200, 0.01, 'bounds');
  assert.equal(root.children[0].contentUrl, 'https://example.test/tiles/c/-200_-200.glb');
  const area = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };
  const view = (y) => ({ x: 0, y, z: 0, frame: 1, area, maxSse: 16, sseFactor: 900 / (2 * Math.tan(Math.PI / 6)) });

  // far away: the root alone
  let s = tiles.selectTiles(root, view(5000));
  assert.deepEqual([...s.requests.map((t) => t.contentUrl)], [root.contentUrl]);
  assert.equal(s.render.length, 0);
  root.state = 'ready';
  s = tiles.selectTiles(root, view(5000));
  assert.deepEqual([...s.render], [root]);

  // close: children wanted; the root stays until all four are in
  s = tiles.selectTiles(root, view(50));
  assert.equal(s.requests.length, 4);
  assert.deepEqual([...s.render], [root]);
  root.children.slice(0, 3).forEach((c) => { c.state = 'ready'; });
  assert.deepEqual([...tiles.selectTiles(root, view(50)).render], [root]);
  root.children[3].state = 'ready';
  assert.deepEqual([...tiles.selectTiles(root, view(50)).render], [...root.children]);
  // a child that can't load doesn't block refinement
  root.children[3].state = 'failed';
  assert.deepEqual([...tiles.selectTiles(root, view(50)).render], [...root.children.slice(0, 3)]);

  // tiles outside the simulated area are ignored
  const outside = tiles.selectTiles(root, { ...view(50), area: { minX: 500, minZ: 500, maxX: 900, maxZ: 900 } });
  assert.equal(outside.render.length + outside.requests.length, 0);
});

test('external tilesets are requested before their content and resolved relative to their own URL', () => {
  const projection = tiles.makeProjection();
  const root = tiles.parseTile({
    boundingVolume: region(-100, -100, 100, 100), geometricError: 50,
    children: [{ boundingVolume: region(-100, -100, 100, 100), geometricError: 20, content: { uri: 'sub/tileset.json' } }]
  }, null, 'https://example.test/a/tileset.json', projection);
  const area = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };
  const s = tiles.selectTiles(root, { x: 0, y: 10, z: 0, frame: 1, area, maxSse: 16, sseFactor: 780 });
  assert.equal(s.requests[0].external, 'https://example.test/a/sub/tileset.json');
  const external = s.requests[0];
  external.children = [tiles.parseTile({ boundingVolume: region(-100, -100, 100, 100), geometricError: 0, content: { uri: '../../7/1/2.glb' } }, external, external.external, projection)];
  external.state = 'ready';
  const next = tiles.selectTiles(root, { x: 0, y: 10, z: 0, frame: 2, area, maxSse: 16, sseFactor: 780 });
  assert.equal(next.requests[0].contentUrl, 'https://example.test/7/1/2.glb');
});
