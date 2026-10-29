const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const tram = loadModule(readFileSync(join(__dirname, '../js/tram.js'), 'utf8'), { imports: { 'three/webgpu': {}, './terrain.js': { groundAt: () => 0 } } });

test('samples points and headings along a tram polyline', () => {
  const pts = [0, 0, 10, 0, 10, 20];
  const cum = tram.polylineLengths(pts);
  assert.deepEqual([...cum], [0, 10, 30]);
  const mid = tram.samplePolyline(pts, cum, 5);
  assert.deepEqual([mid.x, mid.z, mid.dx, mid.dz], [5, 0, 1, 0]);
  const bend = tram.samplePolyline(pts, cum, 20);
  assert.deepEqual([bend.x, bend.z, bend.dx, bend.dz], [10, 10, 0, 1]);
  const past = tram.samplePolyline(pts, cum, 99);
  assert.deepEqual([past.x, past.z], [10, 20]);
});

test('trams stop and dwell at each stop, then continue to the end of the line and re-enter', () => {
  const st = tram.createTramState(400, [150, 300]);
  let t = 0;
  const visits = [];
  let wasDwelling = false;
  while (t < 600) {
    tram.stepTram(st, 0.05);
    t += 0.05;
    assert.ok(st.v <= tram.TRAM_SPEED + 1e-9, 'never exceeds cruise speed');
    const dwelling = st.dwell > 0;
    if (dwelling && !wasDwelling) visits.push(Math.round(st.s));
    wasDwelling = dwelling;
  }
  assert.deepEqual(visits.slice(0, 3), [150, 300, 150], 'stops at both stops, then again on the next run');
});

test('every Helsinki tram line has stops measured along its route', async () => {
  const { HELSINKI_DATA } = await import('../js/helsinki-geodata.js');
  assert.ok(HELSINKI_DATA.tramLines.length > 0);
  for (const line of HELSINKI_DATA.tramLines) {
    const total = tram.polylineLengths(line.pts).at(-1);
    assert.ok(line.stops.length > 0, `line ${line.ref} has stops`);
    for (const stop of line.stops) assert.ok(stop.s >= 0 && stop.s <= total + 1, `${stop.name} lies on line ${line.ref}`);
  }
});

const car = (x, z, heading = 0, extra = {}) => ({ x, z, sin: Math.sin(heading), cos: Math.cos(heading), halfW: 0.9, halfL: 2.2, ...extra });
const front = { x: 0, z: 0, dx: 0, dz: 1 };

test('a tram sees what stands on its track ahead, and not what is beside or behind it', () => {
  assert.equal(tram.trackClearance(front, [car(0, 20)]).gap, 20 - 2.2, 'car ahead on the track, nose to tail');
  assert.equal(tram.trackClearance(front, [car(0, 20, Math.PI / 2)]).gap, 20 - 0.9, 'car crossing the track');
  assert.equal(tram.trackClearance(front, [car(3.5, 20)]).gap, Infinity, 'car in the next lane');
  assert.equal(tram.trackClearance(front, [car(0, -10)]).gap, Infinity, 'car behind the tram');
  assert.equal(tram.trackClearance(front, [car(0, 80)]).gap, Infinity, 'car beyond the lookahead');
  assert.equal(tram.trackClearance(front, [car(0, 1)]).gap, 0, 'car touching the front');
  const seen = tram.trackClearance(front, [car(0, 30), car(0.5, 12, 0, { player: true })]);
  assert.equal(seen.gap, 12 - 2.2, 'nearest obstacle wins');
  assert.equal(seen.player, true);
});

test('a tram brakes to stop short of an obstacle and never runs into it', () => {
  assert.equal(tram.obstacleSpeed(Infinity), Infinity);
  assert.equal(tram.obstacleSpeed(1), 0, 'stops short');
  const st = tram.createTramState(1000, [900]);
  st.v = tram.TRAM_SPEED;
  const obstacleS = 60; // a stopped car, its tail 60 m along the line
  for (let t = 0; t < 30; t += 0.05) tram.stepTram(st, 0.05, tram.obstacleSpeed(obstacleS - st.s));
  assert.ok(st.s < obstacleS - 1, `stopped at ${st.s.toFixed(2)} m, short of the car at ${obstacleS} m`);
  assert.ok(st.v < 0.05, 'standing');
  for (let t = 0; t < 5; t += 0.05) tram.stepTram(st, 0.05);
  assert.ok(st.v > 0, 'pulls away once the track is clear');
});
