// tools/build-helsinki-geodata.mjs — writes js/helsinki-geodata.js from tools/data/osm_helsinki.json (Overpass, query
// q_helsinki.overpassql). All features, including trees (natural=tree), come from OpenStreetMap only.
// Frame: 1 unit = 1 m, x = east, z = south, origin at Senaatintori (true north up, no grid rotation).
// usage: node tools/build-helsinki-geodata.mjs [out.js]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || path.join(DIR, '..', 'js', 'helsinki-geodata.js');
const osm = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'osm_helsinki.json'), 'utf8'));
const log = (...a) => console.log('[helsinki-geodata]', ...a);

const BBOX = [60.16, 24.925, 60.18, 24.965]; // S, W, N, E: must match q_helsinki.overpassql
const LAT0 = 60.16950; // Senaatintori
const LON0 = 24.95220;
const R = 6378137;
const KY = (Math.PI / 180) * R;
const KX = KY * Math.cos((LAT0 * Math.PI) / 180);
const r1 = (v) => Math.round(v * 10) / 10;
const toWorld = (lon, lat) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const flat = (pts) => pts.flatMap(([x, z]) => [r1(x), r1(z)]);
const geomPts = (g) => (g || []).map((p) => toWorld(p.lon, p.lat));

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function bbox(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return { x0, x1, z0, z1 };
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const dx = pts[b][0] - pts[a][0], dz = pts[b][1] - pts[a][1];
    const L = Math.hypot(dx, dz) || 1e-9;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - pts[a][0]) * dz - (pts[i][1] - pts[a][1]) * dx) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const closed = (r) => r.length > 3 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.3;
// Open ring (first point not repeated), simplified
const cleanRing = (r) => {
  const open = closed(r) ? r.slice(0, -1) : r;
  const s = rdp([...open, open[0]], 0.4).slice(0, -1);
  return s.length >= 3 ? s : open;
};

// Chains outer/inner member ways of a relation into closed rings
function chainRings(members) {
  const parts = members.filter((m) => m.geometry && m.geometry.length > 1).map((m) => geomPts(m.geometry));
  const rings = [];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3;
  while (parts.length) {
    let ring = parts.shift();
    for (let guard = 0; guard < 2000 && !near(ring[0], ring[ring.length - 1]); guard++) {
      const end = ring[ring.length - 1];
      const i = parts.findIndex((p) => near(p[0], end) || near(p[p.length - 1], end));
      if (i < 0) break;
      const p = parts.splice(i, 1)[0];
      ring = ring.concat(near(p[0], end) ? p.slice(1) : p.reverse().slice(1));
    }
    if (closed(ring)) rings.push(ring);
  }
  return rings;
}
// Outer rings with their holes: [{ ring, holes }]
function polygons(e) {
  if (e.type === 'way') {
    const r = geomPts(e.geometry);
    return closed(r) ? [{ ring: r, holes: [] }] : [];
  }
  const outers = chainRings((e.members || []).filter((m) => m.role === 'outer' || m.role === ''));
  const inners = chainRings((e.members || []).filter((m) => m.role === 'inner'));
  return outers.map((ring) => {
    const bb = bbox(ring);
    const holes = inners.filter((h) => h[0][0] >= bb.x0 && h[0][0] <= bb.x1 && h[0][1] >= bb.z0 && h[0][1] <= bb.z1);
    return { ring, holes };
  });
}
const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// --- Buildings --------------------------------------------------------------------------------------------------------
const buildings = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node' || !(t.building || t['building:part'])) continue;
  if (t.building === 'roof' || t.building === 'no') continue;
  const part = !t.building;
  for (const [i, p] of polygons(e).entries()) {
    const ring = cleanRing(p.ring);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 4) continue;
    const levels = num(t['building:levels']);
    const minH = num(t.min_height) ?? 0;
    let h = num(t.height), src = 'height';
    // Helsinki's centre is mostly 5–7 storey stone blocks with tall ceilings (~3.4 m per storey)
    if (h == null && levels != null) { h = levels * 3.4 + (t.building === 'church' || t.building === 'cathedral' ? 10 : 1.5); src = 'building:levels'; }
    if (h == null) { h = t.building === 'church' || t.building === 'cathedral' ? 30 : /^(shed|garage|garages|kiosk|hut|service|toilets)$/.test(t.building || '') ? 3.5 : 18; src = 'default'; }
    const o = { id: `${e.type[0]}${e.id}${i ? '_' + i : ''}`, ring: flat(ring), holes: p.holes.map((hh) => flat(cleanRing(hh))), h: r1(h), roofHeight: r1(num(t['roof:height']) ?? 0), roofShape: t['roof:shape'] || 'flat', levels: levels ?? 0, name: t.name || '', kind: t.building || 'part', heightSource: src };
    if (minH) o.minHeight = r1(minH);
    if (part) o.part = true;
    buildings.push(o);
  }
}

// --- Roads & railways ---------------------------------------------------------------------------------------------------
const WIDTH = { motorway: 14, trunk: 12, primary: 10, secondary: 8, tertiary: 7, residential: 6, unclassified: 6, living_street: 5, service: 3.5, pedestrian: 5, cycleway: 2.5, footway: 2, path: 1.5, steps: 2, track: 3 };
const LANES = { motorway: 4, trunk: 4, primary: 2, secondary: 2, tertiary: 2, residential: 2, unclassified: 2, living_street: 1, service: 1 };
const DRIVABLE = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street']);
const drivable = [];
const roads = [];
const railways = [];
const signals = [];
const trees = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') {
    const [x, z] = toWorld(e.lon, e.lat);
    if (t.natural === 'tree') trees.push({ x: r1(x), z: r1(z), h: r1(num(t.height) ?? 8) });
    else if (t.highway === 'traffic_signals') signals.push({ x: r1(x), z: r1(z) });
    continue;
  }
  if (e.type !== 'way' || !e.geometry) continue;
  const bridge = !!t.bridge && t.bridge !== 'no';
  const tunnel = (!!t.tunnel && t.tunnel !== 'no') || t.covered === 'yes';
  const layer = num(t.layer) ?? (bridge ? 1 : tunnel ? -1 : 0);
  if (t.railway && /^(rail|light_rail|tram|subway)$/.test(t.railway)) {
    railways.push({ id: `w${e.id}`, pts: flat(rdp(geomPts(e.geometry), 0.5)), bridge, tunnel, layer, kind: t.railway });
    continue;
  }
  if (!t.highway || /^(proposed|construction|platform|bus_stop|corridor|elevator|raceway)$/.test(t.highway)) continue;
  const kind = t.highway.replace(/_link$/, '') in WIDTH ? t.highway : 'service';
  const base = kind.replace(/_link$/, '');
  const lanes = num(t.lanes) ?? LANES[base] ?? 1;
  const width = num(t.width) ?? Math.max(WIDTH[base] ?? 3, lanes * 3);
  const oneway = t.oneway === 'yes' || t.oneway === '-1' || t.oneway === '1' || t.junction === 'roundabout';
  const road = { id: `w${e.id}`, pts: flat(rdp(geomPts(e.geometry), 0.5)), bridge, tunnel, layer, name: t.name || '', width: r1(width), lanes, oneway, reverse: t.oneway === '-1', kind, nodeIds: e.nodes || [] };
  // Helsinki is bilingual: street signs carry the Swedish name under the Finnish one
  if (t['name:sv'] && t['name:sv'] !== t.name) road.nameSv = t['name:sv'];
  roads.push(road);
  if (DRIVABLE.has(kind) && !tunnel && e.nodes && e.nodes.length === e.geometry.length) {
    drivable.push({ name: t.name || '', width: r1(width), lanes, dir: !oneway ? 0 : t.oneway === '-1' ? -1 : 1, nodes: e.nodes, pts: geomPts(e.geometry) });
  }
}

// --- Street centreline graph: ways cut at every node shared by two ways (and at their ends) ----------------------------
// links: [node a, node b, name index, width, lanes, direction (1: a -> b, -1: b -> a, 0: both), inner shape points [x, z, ...]]
const roadGraph = (() => {
  const uses = new Map();
  for (const w of drivable) for (const id of new Set(w.nodes)) uses.set(id, (uses.get(id) || 0) + 1);
  const ids = new Map();
  const nodes = [];
  const names = [];
  const nameIds = new Map();
  const nodeOf = (id, p) => { if (!ids.has(id)) { ids.set(id, nodes.length / 2); nodes.push(r1(p[0]), r1(p[1])); } return ids.get(id); };
  const nameOf = (n) => { if (!nameIds.has(n)) { nameIds.set(n, names.length); names.push(n); } return nameIds.get(n); };
  const links = [];
  for (const w of drivable) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const last = i === w.nodes.length - 1;
      if (!last && uses.get(w.nodes[i]) < 2 && w.nodes[i] !== w.nodes[0]) continue;
      if (w.nodes[i] === w.nodes[start]) { start = i; continue; }
      const seg = w.pts.slice(start, i + 1);
      const inner = rdp(seg, 0.4).slice(1, -1).flatMap(([x, z]) => [r1(x), r1(z)]);
      links.push([nodeOf(w.nodes[start], seg[0]), nodeOf(w.nodes[i], seg[seg.length - 1]), nameOf(w.name), w.width, w.lanes, w.dir, inner]);
      start = i;
    }
  }
  return { nodes, links, names };
})();

// --- Water & parks -------------------------------------------------------------------------------------------------------
const water = [];
const parks = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type === 'node') continue;
  const isWater = t.natural === 'water' || /^(riverbank|dock)$/.test(t.waterway || '');
  const isPark = /^(park|garden|playground|pitch)$/.test(t.leisure || '') || /^(grass|recreation_ground|cemetery|village_green)$/.test(t.landuse || '');
  if (!isWater && !isPark) continue;
  for (const p of polygons(e)) {
    const ring = cleanRing(p.ring);
    if (ring.length < 3 || Math.abs(ringArea(ring)) < 20) continue;
    if (isWater) water.push({ id: `water${water.length}`, ring: flat(ring), holes: p.holes.map((h) => flat(cleanRing(h))), name: t.name || '', kind: t.water || t.waterway || 'water' });
    else parks.push({ id: `${e.type[0]}${e.id}`, ring: flat(ring), holes: p.holes.map((h) => flat(cleanRing(h))), name: t.name || '', kind: t.leisure || t.landuse });
  }
}

// --- Sea: OSM has no sea polygons, only natural=coastline ways (land on the left, sea on the right). The coastline is
// chained, clipped to the bbox, and closed along the bbox edge into sea polygons; islands inside the bbox become holes.
const [RX0, RZ1] = toWorld(BBOX[1], BBOX[0]);
const [RX1, RZ0] = toWorld(BBOX[3], BBOX[2]);
const RW = RX1 - RX0, RH = RZ1 - RZ0, PERIM = 2 * (RW + RH);
const inRect = ([x, z]) => x >= RX0 && x <= RX1 && z >= RZ0 && z <= RZ1;
// Position along the bbox edge, clockwise as seen from above (north up) starting at the north-west corner
function perimT([x, z]) {
  const d = [Math.abs(z - RZ0), Math.abs(x - RX1), Math.abs(z - RZ1), Math.abs(x - RX0)];
  const side = d.indexOf(Math.min(...d));
  return [x - RX0, RW + (z - RZ0), RW + RH + (RX1 - x), 2 * RW + RH + (RZ1 - z)][side];
}
const CORNERS = [[0, [RX0, RZ0]], [RW, [RX1, RZ0]], [RW + RH, [RX1, RZ1]], [2 * RW + RH, [RX0, RZ1]]];
function snapToRect([x, z]) {
  const d = [Math.abs(z - RZ0), Math.abs(x - RX1), Math.abs(z - RZ1), Math.abs(x - RX0)];
  const side = d.indexOf(Math.min(...d));
  return [[x, RZ0], [RX1, z], [x, RZ1], [RX0, z]][side].map((v, i) => i ? Math.min(RZ1, Math.max(RZ0, v)) : Math.min(RX1, Math.max(RX0, v)));
}
// Liang–Barsky: parameter range [t0, t1] of a -> b inside the bbox, or null
function clipSeg(a, b) {
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - RX0], [dx, RX1 - a[0]], [-dz, a[1] - RZ0], [dz, RZ1 - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// Chains open polylines end -> start (coastline ways share a consistent direction)
function chainLines(lines) {
  const parts = lines.map((l) => l.slice());
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.3;
  const out = [];
  while (parts.length) {
    let line = parts.shift();
    for (let changed = true; changed;) {
      changed = false;
      const i = parts.findIndex((p) => near(line[line.length - 1], p[0]));
      if (i >= 0) { line = line.concat(parts.splice(i, 1)[0].slice(1)); changed = true; }
      const j = parts.findIndex((p) => near(p[p.length - 1], line[0]));
      if (j >= 0) { line = parts.splice(j, 1)[0].concat(line.slice(1)); changed = true; }
    }
    out.push(line);
  }
  return out;
}
const sea = [];
{
  const coast = chainLines(osm.elements.filter((e) => e.type === 'way' && e.tags?.natural === 'coastline' && e.geometry).map((e) => geomPts(e.geometry)));
  const pieces = [];
  const islands = [];
  for (let line of coast) {
    if (closed(line) && line.every(inRect)) { islands.push(line); continue; }
    if (closed(line)) {
      const k = line.findIndex((p) => !inRect(p));
      if (k > 0) line = line.slice(k, -1).concat(line.slice(0, k + 1));
    }
    let cur = null;
    if (inRect(line[0])) cur = [snapToRect(line[0]), line[0]];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], c = clipSeg(a, b);
      if (!c) continue;
      if (!cur) cur = [lerp(a, b, c[0])];
      if (c[1] < 1) { cur.push(lerp(a, b, c[1])); pieces.push(cur); cur = null; } else cur.push(b);
    }
    if (cur) { cur.push(snapToRect(cur[cur.length - 1])); pieces.push(cur); }
  }
  for (const p of pieces) { p.entry = perimT(p[0]); p.exit = perimT(p[p.length - 1]); }
  const used = new Set();
  for (const start of pieces) {
    if (used.has(start)) continue;
    const ring = [];
    let piece = start;
    for (let guard = 0; guard < 1000; guard++) {
      used.add(piece);
      ring.push(...piece);
      // Walk clockwise along the bbox edge (sea on the right) to the next coastline entry
      const from = piece.exit;
      const ahead = (t) => ((t - from) % PERIM + PERIM) % PERIM;
      let next = null;
      for (const p of pieces) if (!next || ahead(p.entry) < ahead(next.entry)) next = p;
      for (const [t, corner] of CORNERS.slice().sort((a, b) => ahead(a[0]) - ahead(b[0]))) if (ahead(t) > 1e-6 && ahead(t) < ahead(next.entry)) ring.push(corner);
      if (next === start || used.has(next)) break;
      piece = next;
    }
    const clean = cleanRing(ring);
    if (clean.length >= 3 && Math.abs(ringArea(clean)) > 100) sea.push({ ring: clean, holes: [] });
  }
  const pip = (poly, [x, z]) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  };
  for (const isl of islands) {
    const host = sea.find((s) => pip(s.ring, isl[0]));
    if (host) host.holes.push(cleanRing(isl));
  }
  for (const s of sea) water.push({ id: `water${water.length}`, ring: flat(s.ring), holes: s.holes.map(flat), name: '', kind: 'sea' });
  log(`sea: ${coast.length} coastline chains, ${pieces.length} clipped pieces, ${sea.length} sea polygons, ${islands.length} islands`);
}

// --- HSL tram lines: route relations (one per direction), member ways chained in order and clipped to the bbox ---------
const nodeById = new Map();
for (const e of osm.elements) if (e.type === 'node') nodeById.set(e.id, e);
const tramLines = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type !== 'relation' || t.route !== 'tram' || !e.members) continue;
  let line = [], ways = 0;
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1;
  for (const m of e.members) {
    if (m.type !== 'way' || !m.geometry || (m.role && m.role !== 'forward' && m.role !== 'backward')) continue;
    let p = geomPts(m.geometry);
    if (!ways++) { line = p; continue; }
    // The first way's direction is only known once the second one attaches to either of its ends
    if (ways === 2 && !near(p[0], line[line.length - 1]) && !near(p[p.length - 1], line[line.length - 1]) && (near(p[0], line[0]) || near(p[p.length - 1], line[0]))) line.reverse();
    const end = line[line.length - 1];
    if (near(p[p.length - 1], end)) p = p.reverse();
    line = line.concat(near(p[0], end) ? p.slice(1) : p);
  }
  // Keep the longest stretch that stays within 40 m of the bbox
  let best = [], cur = [];
  const margin = ([x, z]) => x > RX0 - 40 && x < RX1 + 40 && z > RZ0 - 40 && z < RZ1 + 40;
  for (const p of line) { if (margin(p)) { cur.push(p); if (cur.length > best.length) best = cur; } else cur = []; }
  if (best.length < 2) continue;
  const pts = rdp(best, 0.3);
  // Stops: the stop positions (PTv2) or platforms (PTv1) of the route, snapped onto the line with their distance along it
  const stops = [];
  for (const m of e.members) {
    if (!/^(stop|platform)/.test(m.role || '') || m.type !== 'node') continue;
    const n = nodeById.get(m.ref) || m;
    if (n.lat == null) continue;
    const [x, z] = toWorld(n.lon, n.lat);
    let bestD = Infinity, bestS = 0, bestP = null, acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1e-9;
      const u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (L * L)));
      const d = Math.hypot(a[0] + u * dx - x, a[1] + u * dz - z);
      if (d < bestD) { bestD = d; bestS = acc + u * L; bestP = [a[0] + u * dx, a[1] + u * dz]; }
      acc += L;
    }
    if (bestD > 25 || bestS < 5 || bestS > acc - 5) continue;
    let name = n.tags?.name || '';
    if (!name) for (const q of osm.elements) if (q.type === 'node' && q.tags?.railway === 'tram_stop' && q.tags.name && Math.hypot(...toWorld(q.lon, q.lat).map((v, k) => v - [x, z][k])) < 40) { name = q.tags.name; break; }
    if (stops.some((q) => Math.abs(q.s - bestS) < 30)) continue;
    stops.push({ x: r1(bestP[0]), z: r1(bestP[1]), s: r1(bestS), name });
  }
  stops.sort((a, b) => a.s - b.s);
  tramLines.push({ id: `r${e.id}`, ref: t.ref || '', name: t.name || '', from: t.from || '', to: t.to || '', colour: t.colour || '#00985f', pts: flat(pts), stops });
}
const tramStops = osm.elements.filter((e) => e.type === 'node' && e.tags?.railway === 'tram_stop').map((e) => { const [x, z] = toWorld(e.lon, e.lat); return { x: r1(x), z: r1(z), name: e.tags.name || '', nameSv: e.tags['name:sv'] || '' }; });

// --- Districts (kaupunginosat, admin_level 10), clipped to the bbox; labelled at their building centroid ----------------
function clipToRect(ring) {
  let out = ring;
  for (const [inside, cut] of [
    [(p) => p[0] >= RX0, (a, b) => lerp(a, b, (RX0 - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= RX1, (a, b) => lerp(a, b, (RX1 - a[0]) / (b[0] - a[0]))],
    [(p) => p[1] >= RZ0, (a, b) => lerp(a, b, (RZ0 - a[1]) / (b[1] - a[1]))],
    [(p) => p[1] <= RZ1, (a, b) => lerp(a, b, (RZ1 - a[1]) / (b[1] - a[1]))]
  ]) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      if (inside(a)) { out.push(a); if (!inside(b)) out.push(cut(a, b)); } else if (inside(b)) out.push(cut(a, b));
    }
  }
  return out;
}
const areas = [];
for (const e of osm.elements) {
  const t = e.tags || {};
  if (e.type !== 'relation' || t.boundary !== 'administrative' || t.admin_level !== '10' || !t.name) continue;
  const polys = polygons(e).map((p) => clipToRect(cleanRing(p.ring))).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1000);
  if (!polys.length) continue;
  const areaM2 = polys.reduce((s, r) => s + Math.abs(ringArea(r)), 0);
  const pip = (poly, x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  let sx = 0, sz = 0, n = 0;
  for (const b of buildings) {
    if (b.part) continue;
    const x = b.ring[0], z = b.ring[1];
    if (polys.some((r) => pip(r, x, z))) { sx += x; sz += z; n++; }
  }
  if (!n) continue;
  const id = t.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_');
  areas.push({ id, name: t.name, nameSv: t['name:sv'] || '', polygons: polys.map((r) => ({ ring: flat(r), holes: [] })), labelPoint: [r1(sx / n), r1(sz / n)], areaKm2: Math.round(areaM2 / 1e4) / 100 });
}

// --- Landmarks: footprints for named buildings ----------------------------------------------------------------------------
// [OSM name, height override in metres or 0 to keep the mapped height]
const LANDMARKS = new Map([
  ['Helsingin tuomiokirkko', 62], ['Uspenskin katedraali', 51], ['Helsingin päärautatieasema', 48], ['Ateneum', 0], ['Stockmann', 0],
  ['Presidentinlinna', 0], ['Suomen Kansallisteatteri', 0], ['Kiasma', 0], ['Helsingin keskustakirjasto Oodi', 0], ['Musiikkitalo', 0],
  ['Vanha Kauppahalli', 0], ['Helsingin kaupungintalo', 0], ['Säätytalo', 0], ['Valtioneuvoston linna', 0], ['Helsingin yliopiston päärakennus', 0],
  ['Ritarihuone', 0], ['Sederholmin talo', 0], ['Lasipalatsi', 0], ['Kaartin maneesi', 0]
]);
const landmarks = {};
for (const b of buildings) {
  if (b.part || !LANDMARKS.has(b.name)) continue;
  const pts = [];
  for (let i = 0; i < b.ring.length; i += 2) pts.push([b.ring[i], b.ring[i + 1]]);
  const bb = bbox(pts);
  const area = Math.abs(ringArea(pts));
  if (landmarks[b.name] && landmarks[b.name].area >= area) continue;
  landmarks[b.name] = { x: r1((bb.x0 + bb.x1) / 2), z: r1((bb.z0 + bb.z1) / 2), w: r1(bb.x1 - bb.x0), d: r1(bb.z1 - bb.z0), h: LANDMARKS.get(b.name) || b.h, area: Math.round(area), ring: b.ring };
}

const [s, w, n, eLon] = BBOX;
const [minX, maxZ0] = toWorld(w, s);
const [maxX, minZ] = toWorld(eLon, n);
const data = {
  meta: {
    name: 'Helsinki · keskusta', city: 'Helsinki',
    bounds: [r1(minX), r1(minZ), r1(maxX), r1(maxZ0)],
    geographicBounds: [s, w, n, eLon],
    frame: 'x = east, z = south, metres; origin at Senaatintori',
    coordinateSystem: 'x east, z south, metres',
    lonLatAffine: { lon0: LON0, lat0: LAT0, x: [0, r1(KX * 1e3) / 1e3, 0], z: [0, 0, -r1(KY * 1e3) / 1e3], maxErrorM: 0.5 },
    sources: [{ name: 'OpenStreetMap contributors', license: 'ODbL 1.0', attribution: '© OpenStreetMap contributors' }],
    areas,
    counts: { buildings: buildings.length, roads: roads.length, water: water.length, parks: parks.length, railways: railways.length, trees: trees.length, signals: signals.length, tramLines: tramLines.length, tramStops: tramStops.length }
  },
  buildings, roads, water, parks, railways, trees, signals, landmarks, roadGraph, tramLines, tramStops
};
fs.writeFileSync(OUT, `// js/helsinki-geodata.js — GENERATED by tools/build-helsinki-geodata.mjs, do not edit by hand.\n// Helsinki city centre, 1 unit = 1 m, x east, z south, origin at Senaatintori. © OpenStreetMap contributors (ODbL).\nexport const HELSINKI_DATA = ${JSON.stringify(data)};\n`);
log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`, JSON.stringify(data.meta.counts));
log('landmarks:', Object.keys(landmarks).join(', '));
log('areas:', areas.map((a) => a.name).join(', '));
log('tram lines:', tramLines.map((l) => `${l.ref} (${l.stops.length} stops)`).join(', '));
