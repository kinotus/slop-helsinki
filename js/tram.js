import * as THREE from 'three/webgpu';
import { groundAt } from './terrain.js';

// HSL trams (raitiovaunut) running the OSM tram routes of js/helsinki-geodata.js. Each route relation is one direction
// of a line, so trams run forward along it, dwell at its stops and re-enter at the start after the last one. A tram is
// three articulated sections, each placed on the polyline at its own distance so the train bends through curves.

export const TRAM_SPEED = 8; // m/s cruising
export const TRAM_ACCEL = 1.1; // m/s² (also used to brake towards stops)
export const TRAM_DWELL = 14; // s at each stop
export const SECTION_LENGTH = 9.2;
export const SECTION_GAP = 0.6;
export const TRAM_HALF_WIDTH = 1.22;
export const TRAM_BRAKE = 3; // m/s² service braking for something on the track
export const TRAM_LOOKAHEAD = 40; // metres a driver watches the track ahead
export const TRAM_PATIENCE = 12; // s held by traffic before the driver edges on regardless (the player is always waited for)
const STOP_SHORT = 2.5; // metres kept clear of an obstacle
const SECTION_COUNT = 3;
const TRAM_LENGTH = SECTION_COUNT * SECTION_LENGTH + (SECTION_COUNT - 1) * SECTION_GAP;

/**
 * Clear distance from a tram front (point x, z heading dx, dz) to the nearest obstacle on its track ahead.
 * Obstacles are oriented boxes { x, z, sin, cos, halfW, halfL, player? }. Returns { gap, player } (gap Infinity if clear).
 */
export function trackClearance(front, obstacles, out = { gap: Infinity, player: false }) {
  out.gap = Infinity;
  out.player = false;
  for (const o of obstacles) {
    const rx = o.x - front.x;
    const rz = o.z - front.z;
    if (Math.abs(rx) > TRAM_LOOKAHEAD + 6 || Math.abs(rz) > TRAM_LOOKAHEAD + 6) continue;
    const ahead = rx * front.dx + rz * front.dz;
    const right = rz * front.dx - rx * front.dz;
    const c = Math.abs(o.sin * front.dx + o.cos * front.dz);
    const s = Math.abs(o.sin * front.dz - o.cos * front.dx);
    const along = o.halfL * c + o.halfW * s;
    const across = o.halfL * s + o.halfW * c;
    if (Math.abs(right) > TRAM_HALF_WIDTH + across + 0.3) continue;
    if (ahead + along < 0 || ahead - along > TRAM_LOOKAHEAD) continue;
    const gap = Math.max(0, ahead - along);
    if (gap < out.gap) {
      out.gap = gap;
      out.player = Boolean(o.player);
    }
  }
  return out;
}

/** Highest speed from which a tram can still stop STOP_SHORT before something `gap` metres ahead. */
export function obstacleSpeed(gap) {
  return gap === Infinity ? Infinity : Math.sqrt(2 * TRAM_BRAKE * Math.max(0, gap - STOP_SHORT));
}

/** Cumulative distances along a flat [x0, z0, x1, z1, …] polyline. */
export function polylineLengths(pts) {
  const n = pts.length / 2;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  }
  return cum;
}

/** Point and heading at distance s along the polyline (clamped to its ends). */
export function samplePolyline(pts, cum, s, out = { x: 0, z: 0, dx: 1, dz: 0 }) {
  const n = cum.length;
  const total = cum[n - 1];
  const t = Math.min(Math.max(s, 0), total);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const f = (t - cum[lo]) / seg;
  const ax = pts[2 * lo], az = pts[2 * lo + 1], bx = pts[2 * hi], bz = pts[2 * hi + 1];
  out.x = ax + (bx - ax) * f;
  out.z = az + (bz - az) * f;
  const len = Math.hypot(bx - ax, bz - az) || 1;
  out.dx = (bx - ax) / len;
  out.dz = (bz - az) / len;
  return out;
}

/** Creates the motion state of one tram on a line of the given length with stop distances `stops` (ascending). */
export function createTramState(total, stops, s = 0) {
  return { total, stops, s, v: 0, dwell: 0, held: 0, nextStop: stops.findIndex((d) => d > s + 0.5) };
}

/** Advances a tram: accelerate to cruise, brake to stop at the next stop, dwell there, wrap at the end of the line.
 * `limitV` caps the speed for something on the track ahead (see obstacleSpeed). */
export function stepTram(st, dt, limitV = Infinity) {
  if (st.dwell > 0) {
    st.dwell -= dt;
    return st;
  }
  const target = st.nextStop >= 0 ? st.stops[st.nextStop] : st.total + TRAM_LENGTH;
  const dist = target - st.s;
  const brakeV = Math.sqrt(Math.max(0, 2 * TRAM_ACCEL * dist));
  const want = Math.min(TRAM_SPEED, st.nextStop >= 0 ? brakeV : TRAM_SPEED);
  st.v = want > st.v ? Math.min(want, st.v + TRAM_ACCEL * dt) : want;
  if (st.nextStop >= 0 && st.v < 0.3) st.v = Math.min(0.3, dist / Math.max(dt, 1e-3));
  st.v = Math.min(st.v, limitV);
  st.s += st.v * dt;
  if (st.nextStop >= 0 && st.s >= target - 0.05) {
    st.s = target;
    st.v = 0;
    st.dwell = TRAM_DWELL;
    st.nextStop = st.nextStop + 1 < st.stops.length ? st.nextStop + 1 : -1;
  } else if (st.nextStop < 0 && st.s >= st.total + TRAM_LENGTH) {
    // Off the end of the line: re-enter at its start
    st.s = 0;
    st.v = TRAM_SPEED * 0.5;
    st.nextStop = st.stops.findIndex((d) => d > 0.5);
  }
  return st;
}

function sectionGeometry() {
  // Box body with a slightly narrower roof module, origin at road level under the section centre
  const body = new THREE.BoxGeometry(2.4, 2.6, SECTION_LENGTH);
  body.translate(0, 0.35 + 1.3, 0);
  return body;
}

export function createTramSystem(scene, tramLines = []) {
  const group = new THREE.Group();
  group.name = 'HSLTrams';
  scene.add(group);

  const lines = tramLines
    .filter((l) => l.pts && l.pts.length >= 4)
    .map((l) => {
      const cum = polylineLengths(l.pts);
      const total = cum[cum.length - 1];
      const stops = (l.stops || []).map((p) => p.s).filter((d) => d > 0 && d < total).sort((a, b) => a - b);
      return { ...l, cum, total, stopS: stops };
    })
    .filter((l) => l.total > TRAM_LENGTH * 2);

  // One tram per ~900 m of line, staggered along it
  const trams = [];
  for (const line of lines) {
    const count = Math.max(1, Math.round(line.total / 900));
    for (let k = 0; k < count; k++) trams.push({ line, st: createTramState(line.total, line.stopS, (line.total * k) / count) });
  }

  const n = Math.max(1, trams.length * SECTION_COUNT);
  const geo = sectionGeometry();
  const lowerGeo = new THREE.BoxGeometry(2.42, 1.05, SECTION_LENGTH - 0.1).translate(0, 0.35 + 0.52, 0);
  const windowGeo = new THREE.BoxGeometry(2.44, 0.95, SECTION_LENGTH - 0.8).translate(0, 0.35 + 1.75, 0);
  const roofGeo = new THREE.BoxGeometry(1.6, 0.35, SECTION_LENGTH * 0.6).translate(0, 0.35 + 2.6 + 0.17, 0);

  const make = (g, color, extra = {}) => {
    const mesh = new THREE.InstancedMesh(g, new THREE.MeshStandardNodeMaterial({ color, roughness: 0.45, metalness: 0.15, ...extra }), n);
    mesh.count = trams.length * SECTION_COUNT;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  const meshes = [
    make(geo, 0xf2f3f0), // white body
    make(lowerGeo, 0x00985f), // HSL tram green skirt
    make(windowGeo, 0x1b2a2f, { roughness: 0.1, metalness: 0.6 }), // glazing band
    make(roofGeo, 0x8c9396) // roof equipment
  ];

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const p0 = { x: 0, z: 0, dx: 1, dz: 0 };
  const p1 = { x: 0, z: 0, dx: 1, dz: 0 };
  const clearance = { gap: Infinity, player: false };

  // Solid oriented boxes of every section, for traffic.js to give way to and collide with (mass 0: immovable)
  const sections = trams.flatMap(() => Array.from({ length: SECTION_COUNT }, () => ({
    x: 0, z: 0, prevX: 0, prevZ: 0, sin: 0, cos: 1, halfW: TRAM_HALF_WIDTH, halfL: SECTION_LENGTH / 2,
    speed: 0, vx: 0, vz: 0, hidden: true, placed: false
  })));

  function place() {
    let i = 0;
    for (const { line, st } of trams) {
      for (let k = 0; k < SECTION_COUNT; k++) {
        // Front of the tram at st.s, sections trailing behind it; each is aligned between its two bogies
        const front = st.s - k * (SECTION_LENGTH + SECTION_GAP);
        samplePolyline(line.pts, line.cum, front, p0);
        samplePolyline(line.pts, line.cum, front - SECTION_LENGTH, p1);
        let dx = p0.x - p1.x;
        let dz = p0.z - p1.z;
        const len = Math.hypot(dx, dz);
        if (len < 0.5) { dx = p0.dx; dz = p0.dz; } else { dx /= len; dz /= len; }
        // Each section rests on its two bogies: their mean ground height, pitched along the slope between them
        const g0 = groundAt(p0.x, p0.z), g1 = groundAt(p1.x, p1.z);
        pos.set((p0.x + p1.x) / 2, (g0 + g1) / 2, (p0.z + p1.z) / 2);
        euler.set(-Math.atan2(g0 - g1, Math.max(len, 0.5)), Math.atan2(dx, dz), 0, 'YXZ');
        q.setFromEuler(euler);
        // Sections still off either end of the line (entering or leaving) are hidden
        const hidden = front - SECTION_LENGTH < 0 || front > line.total;
        scale.setScalar(hidden ? 0 : 1);
        m.compose(pos, q, scale);
        for (const mesh of meshes) mesh.setMatrixAt(i, m);
        const b = sections[i];
        // A section that jumped (re-entering at the start of its line) has no previous position to sweep from
        const jumped = !b.placed || hidden !== b.hidden || Math.abs(pos.x - b.x) + Math.abs(pos.z - b.z) > 20;
        b.prevX = jumped ? pos.x : b.x;
        b.prevZ = jumped ? pos.z : b.z;
        b.x = pos.x;
        b.z = pos.z;
        b.sin = dx;
        b.cos = dz;
        b.speed = st.v;
        b.vx = dx * st.v;
        b.vz = dz * st.v;
        b.hidden = hidden;
        b.placed = true;
        i++;
      }
    }
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }
  place();

  return {
    group,
    trams,
    sections,
    /** Steps every tram; `obstacles` are the oriented boxes (traffic, the player) that a tram stops short of. */
    update(dt, obstacles = []) {
      for (const t of trams) {
        const { line, st } = t;
        let limitV = Infinity;
        if (obstacles.length && st.dwell <= 0 && st.s > 0 && st.s < line.total) {
          samplePolyline(line.pts, line.cum, st.s, p0);
          trackClearance(p0, obstacles, clearance);
          limitV = obstacleSpeed(clearance.gap);
          // Held up by traffic for long enough, a driver edges on (traffic is pushed aside); never into the player
          if (limitV < 0.5 && !clearance.player) {
            st.held += dt;
            if (st.held > TRAM_PATIENCE) limitV = 1.2;
          } else if (limitV >= 0.5) {
            st.held = 0;
          }
        }
        stepTram(st, dt, limitV);
      }
      place();
    }
  };
}
