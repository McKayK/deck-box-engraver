import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import Module from 'manifold-3d/manifold.js';

/* ---------- Box profiles ----------
   Each profile is one deck box model: its STL (embedded by the build from assets/) and a table of faces.
   Face coords are the model's own coords (this box lies on its back, front = +z, top = -y).
   Each face: outward normal N, art "up" U, center c of the full face, full face size (w along R, h along U),
   wall thickness behind the face, default depth, and thin strips (local rects) where the wall is thinner. */
const PROFILES = [
  {
    id: 'top-loader', name: 'Top loader', stl: 'deck-box-top-loader.stl',
    faces: (() => {
      const X = 39.67, Y = 51.82;
      return [
        { id: 'left',   name: 'Left side',  N: [1, 0, 0],  U: [0, -1, 0], c: [X, 0, 36.175],  w: 72.85, h: 103.64, wall: 3.77, depth: 1.0,
          thin: [{ r: [31.3, -52, 37, 52], wall: 1.32, what: 'the lid rail along the front edge' }] },
        { id: 'right',  name: 'Right side', N: [-1, 0, 0], U: [0, -1, 0], c: [-X, 0, 36.175], w: 72.85, h: 103.64, wall: 3.77, depth: 1.0,
          thin: [{ r: [-37, -52, -31.3, 52], wall: 1.32, what: 'the lid rail along the front edge' }] },
        { id: 'back',   name: 'Back',       N: [0, 0, -1], U: [0, -1, 0], c: [0, 0, -0.25],   w: 79.34, h: 103.64, wall: 1.05, depth: 0.5, thin: [] },
        { id: 'top',    name: 'Top',        N: [0, -1, 0], U: [0, 0, -1], c: [0, -Y, 34.375], w: 79.34, h: 69.25, wall: 5.3,  depth: 1.0, thin: [] },
        { id: 'bottom', name: 'Bottom',     N: [0, 1, 0],  U: [0, 0, 1],  c: [0, Y, 36.175],  w: 79.34, h: 72.85, wall: 4.05, depth: 1.0,
          thin: [{ r: [-40, 31.3, 40, 37], wall: 1.32, what: 'the lid rail along the front edge' }] },
      ];
    })(),
  },
];

const DEFAULT_SCALE = 85;
const MAX_FILAMENTS = 4;          // AMS slots
const LAYER_H = 0.2;              // typical layer height, for the color-swap note
let artCounter = 0;
const INLAY_COLORS = ['#c9a23a', '#3d6b4f', '#1f1f1f', '#8a2f2a', '#2c4f7c'];
const ENGRAVE_COLOR = 0x2f5d50, ENGRAVE_SEL = 0xb4532a;
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const faceMat = (f, lift = 0) => [
  ...f.R, 0, ...f.U, 0, ...f.N, 0,
  f.c[0] + f.N[0]*lift, f.c[1] + f.N[1]*lift, f.c[2] + f.N[2]*lift, 1];
let profile = PROFILES[0], FACES = [];
const faceById = id => FACES.find(f => f.id === id);

const $ = s => document.querySelector(s);
const state = {};   // face id -> art state (see setArt)
let wasm, boxManifold, boxGeo;
const rectCS = (x0, y0, x1, y1) => new wasm.CrossSection([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
const emptyCS = () => new wasm.CrossSection([[[0, 0], [1, 0], [2, 0]]]);   // zero-area polygon = empty
const unionAll = list => list.length ? (list.length === 1 ? list[0].translate([0, 0]) : wasm.CrossSection.union(list)) : emptyCS();

/* ---------- STL in/out ---------- */
function parseSTL(buf) {
  const dv = new DataView(buf), n = dv.getUint32(80, true);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++)
    pos[i*9 + v*3 + k] = dv.getFloat32(84 + i*50 + 12 + v*12 + k*4, true);
  return pos;
}
function toManifold(pos) {
  const map = new Map(), verts = [], tris = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${pos[i*3].toFixed(4)},${pos[i*3+1].toFixed(4)},${pos[i*3+2].toFixed(4)}`;
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(pos[i*3], pos[i*3+1], pos[i*3+2]); }
    tris[i] = id;
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: tris });
  mesh.merge();
  return new wasm.Manifold(mesh);
}
function meshToGeo(mesh) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1));
  const ng = g.toNonIndexed(); ng.computeVertexNormals(); g.dispose();
  return ng;
}
function writeSTL(mesh) {
  const v = mesh.vertProperties, t = mesh.triVerts, n = t.length / 3;
  const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;
    const p = [0, 1, 2].map(k => [v[t[i*3+k]*3], v[t[i*3+k]*3+1], v[t[i*3+k]*3+2]]);
    const a = p[1].map((x, j) => x - p[0][j]), b = p[2].map((x, j) => x - p[0][j]);
    let nn = cross(a, b); const l = Math.hypot(...nn) || 1; nn = nn.map(x => x / l);
    nn.forEach((x, j) => dv.setFloat32(o + j*4, x, true));
    p.forEach((q, k) => q.forEach((x, j) => dv.setFloat32(o + 12 + k*12 + j*4, x, true)));
  }
  return buf;
}

/* ---------- Color helpers ---------- */
function normColor(str) {
  if (!str || str === 'none' || str === 'transparent') return null;
  if (str === 'currentColor') return '#000000';
  try { return '#' + new THREE.Color().setStyle(str).getHexString(); } catch { return null; }
}
function hexToLab(hex) {
  const lin = c => (c /= 255, c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16)));
  const X = (r*0.4124 + g*0.3576 + b*0.1805) / 0.95047, Y = r*0.2126 + g*0.7152 + b*0.0722, Z = (r*0.0193 + g*0.1192 + b*0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const luminance = hex => hexToLab(hex)[0];

/* ---------- SVG -> colored layers ----------
   Returns layers: [{ hex, cs, area }] where cs is the region of that color actually visible (shapes painted later
   cover earlier ones), all normalized so the whole design's largest side = 1 unit, centered at the origin. */
function gradientColor(doc, id, depth = 0) {
  const g = doc.getElementById(id); if (!g || depth > 3) return null;
  const stops = [...g.querySelectorAll('stop')];
  if (!stops.length) { const href = g.getAttribute('href') || g.getAttribute('xlink:href'); return href ? gradientColor(doc, href.slice(1), depth + 1) : null; }
  const s = stops[Math.floor((stops.length - 1) / 2)];
  const style = s.getAttribute('style') || '';
  return normColor(s.getAttribute('stop-color') || (style.match(/stop-color\s*:\s*([^;]+)/) || [])[1] || '#888');
}
function strokeCS(pts, closed, w) {   // polyline -> union of segment quads (square caps close the joins)
  const quads = [], h = w / 2, P = closed ? [...pts, pts[0]] : pts;
  for (let i = 0; i < P.length - 1; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[i + 1], L = Math.hypot(x1 - x0, y1 - y0); if (L < 1e-9) continue;
    const ux = (x1 - x0) / L * h, uy = (y1 - y0) / L * h, nx = -uy, ny = ux;
    quads.push([[x0 - ux + nx, y0 - uy + ny], [x0 - ux - nx, y0 - uy - ny], [x1 + ux - nx, y1 + uy - ny], [x1 + ux + nx, y1 + uy + ny]]);
  }
  return quads.length ? new wasm.CrossSection(quads, 'NonZero') : null;
}
function parseSVG(text) {
  const data = new SVGLoader().parse(text);
  let doc = null; const docOf = () => doc || (doc = new DOMParser().parseFromString(text, 'image/svg+xml'));
  const shapes = []; let skippedOutlines = 0, gradients = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of data.paths) for (const sp of p.subPaths) for (const q of sp.getPoints(4)) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const maxDim = Math.max(x1 - x0, y1 - y0) || 1;
  for (const p of data.paths) {
    const st = p.userData?.style || {};
    if (st.visibility === 'hidden' || st.opacity === 0) continue;
    let fill = st.fill;
    if (typeof fill === 'string' && fill.startsWith('url(')) { fill = gradientColor(docOf(), fill.slice(5, -1).replace(/^#/, '').replace(/["')]/g, '')) || '#888888'; gradients++; }
    else fill = normColor(fill);
    if (st.fillOpacity === 0) fill = null;
    const rings = [];
    for (const sp of p.subPaths) {
      const pts = sp.getPoints(16);
      if (pts.length >= 2) rings.push({ pts: pts.map(q => [q.x, -q.y]), closed: sp.autoClose || pts[0].distanceTo(pts[pts.length - 1]) < 1e-6 });
    }
    if (fill) {
      const polys = rings.filter(r => r.pts.length >= 3).map(r => r.pts);
      if (polys.length) shapes.push({ hex: fill, cs: new wasm.CrossSection(polys, st.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero') });
    }
    // Strokes become filled shapes, except hairline outlines in the fill's own color (tracers add those to hide seams).
    const stroke = normColor(st.stroke), sw = +st.strokeWidth || 0;
    if (stroke && sw > 0 && st.strokeOpacity !== 0 && !(stroke === fill) && sw > maxDim * 0.0008) {
      const parts = rings.map(r => strokeCS(r.pts, r.closed, sw)).filter(Boolean);
      if (parts.length) { shapes.push({ hex: stroke, cs: unionAll(parts) }); parts.forEach(x => x.delete()); }
    } else if (!fill && !stroke) skippedOutlines++;
  }
  if (!shapes.length) throw new Error('No shapes found in this SVG.' + (/<image/.test(text) ? ' It contains an embedded picture, which can\'t be engraved. Trace it to vectors first (Inkscape: Path → Trace Bitmap).' : ''));
  // Painter's order: each shape only keeps what nothing painted after it covers.
  const visible = new Map(); let above = null;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const sh = shapes[i];
    const vis = above ? sh.cs.subtract(above) : sh.cs.translate([0, 0]);
    const na = above ? above.add(sh.cs) : sh.cs.translate([0, 0]); if (above) above.delete(); above = na;
    if (!vis.isEmpty()) { const prev = visible.get(sh.hex); visible.set(sh.hex, prev ? prev.add(vis) : vis); if (prev) { prev.delete(); vis.delete(); } }
    sh.cs.delete();
  }
  const b = above.bounds(); const total = above.area(); above.delete();
  if (!(b.max[0] > b.min[0])) throw new Error('No shapes found in this SVG.');
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, s = 1 / Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  const layers = [];
  for (const [hex, cs] of visible) {
    const norm = cs.translate([-cx, -cy]).scale([s, s]); const a = cs.area(); cs.delete();
    if (a > total * 1e-5) layers.push({ hex, cs: norm, area: a / total }); else norm.delete();
  }
  layers.sort((p, q) => q.area - p.area);
  return { layers, rw: (b.max[0] - b.min[0]) * s, rh: (b.max[1] - b.min[1]) * s, skippedOutlines, gradients, hasImage: /<image/.test(text) };
}

// Background = a color that covers most of a thin band around the design's edge (e.g. a white box behind the art).
function detectBackground(layers, rw, rh) {
  const band = rectCS(-rw / 2, -rh / 2, rw / 2, rh / 2).subtract(rectCS(-rw / 2 + 0.02, -rh / 2 + 0.02, rw / 2 - 0.02, rh / 2 - 0.02));
  const ba = band.area(); let best = null;
  for (const l of layers) { const hit = l.cs.intersect(band), share = hit.area() / ba; hit.delete(); if (share > 0.6 && (!best || share > best.share)) best = { hex: l.hex, share }; }
  band.delete();
  return best?.hex || null;
}
// Merge colors into n filaments: repeatedly merge the two closest clusters (Lab distance). Cluster color = its biggest member.
function clusterColors(layers, hexes, n) {
  let cl = hexes.map(h => { const l = layers.find(x => x.hex === h); return { members: [h], lead: h, area: l.area, lab: hexToLab(h) }; });
  while (cl.length > n) {
    let bi = 0, bj = 1, bd = Infinity;
    for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) { const d = labDist(cl[i].lab, cl[j].lab); if (d < bd) { bd = d; bi = i; bj = j; } }
    const a = cl[bi], b = cl[bj], big = a.area >= b.area ? a : b;
    cl.splice(bj, 1); cl[bi] = { members: [...a.members, ...b.members], lead: big.lead, area: a.area + b.area, lab: big.lab };
  }
  return cl.sort((p, q) => q.area - p.area);
}
function autoAssign(s, n) {
  const keep = {}; for (const [h, t] of Object.entries(s.assign || {})) if (t === 'box' || t === 'engrave') keep[h] = t;
  const free = s.layers.map(l => l.hex).filter(h => !keep[h]);
  const cl = clusterColors(s.layers, free, Math.max(1, Math.min(n, free.length)));
  s.assign = { ...keep };
  s.fils = cl.map((c, i) => { c.members.forEach(h => s.assign[h] = 'f' + (i + 1)); return { color: c.lead, weight: s.fils?.[i]?.weight || 0 }; });
  s.nFil = cl.length;
}

/* ---------- Art -> groups (what gets cut / inlaid) ---------- */
// A group is a set of source colors that print as one thing: an inlay filament, engrave-only, or box color.
function groupSpecs(s) {
  if (!s.multi) return [{ key: s.mode === 'inlay' ? 'f1' : 'engrave', kind: s.mode === 'inlay' ? 'inlay' : 'engrave', color: s.color, weight: s.weight, hexes: [s.layers[0].hex], label: s.mode === 'inlay' ? 'Inlay' : 'Engrave' }];
  const out = [];
  for (let i = 0; i < s.nFil; i++) out.push({ key: 'f' + (i + 1), kind: 'inlay', color: s.fils[i].color, weight: s.fils[i].weight, hexes: [], label: `Filament ${i + 1}` });
  out.push({ key: 'engrave', kind: 'engrave', color: null, weight: 0, hexes: [], label: 'Engrave only' });
  out.push({ key: 'box', kind: 'box', color: null, weight: 0, hexes: [], label: 'Box color' });
  for (const l of s.layers) out.find(g => g.key === (s.assign[l.hex] || 'box')).hexes.push(l.hex);
  return out;
}
function artKey(s) {
  return [s.uid, s.rot, s.scale, s.multi ? JSON.stringify([s.assign, s.fils.slice(0, s.nFil).map(f => f.weight), s.speck]) : `${s.mode}|${s.weight}`].join('|');
}
// Rotated, scaled and cleaned art centered at the origin, in mm. Cached until something that changes the shape changes.
function baseArt(f, s) {
  const key = artKey(s);
  if (s._key === key) return s._base;
  const rot = s.rot % 180 !== 0, w = rot ? s.rh : s.rw, h = rot ? s.rw : s.rh;
  const fit = Math.min(f.w / w, f.h / h) * s.scale / 100;
  const L = s.layers.map(l => ({ hex: l.hex, cs: l.cs.rotate(-s.rot).scale([fit, fit]) }));
  const specs = groupSpecs(s);
  let groups;
  if (!s.multi) {
    const g = specs[0];
    // The extra 0.005 mm merges shapes that touch at a single point (they'd leave non-manifold edges in the STL).
    const cs = (g.weight ? L[0].cs.offset(g.weight / 2 + 0.005, 'Round', 2, 12) : L[0].cs.offset(0.005, 'Miter', 2)).simplify(0.01);
    groups = [{ ...g, cs }];
  } else groups = resolveMulti(L, specs, s.speck);
  L.forEach(l => l.cs.delete());
  const cutGroups = groups.filter(g => g.kind !== 'box' && !g.cs.isEmpty());
  let sil = unionAll(cutGroups.map(g => g.cs));
  if (s.multi) { const c = sil.offset(0.01, 'Miter', 2).offset(-0.01, 'Miter', 2).simplify(0.0001); sil.delete(); sil = c; }
  const b = sil.bounds(), empty = sil.isEmpty();
  if (s._base) disposeBase(s._base);
  s._base = { groups: cutGroups, boxRegion: groups.find(g => g.kind === 'box')?.cs, sil, W: w * fit, H: h * fit,
    bx: empty ? [0, 0] : [b.min[0], b.max[0]], by: empty ? [0, 0] : [b.min[1], b.max[1]] };
  s._key = key;
  return s._base;
}
function disposeBase(b) { b.groups.forEach(g => g.cs.delete()); b.boxRegion?.delete(); b.sil.delete(); }

// Multi-color clean-up: group by filament, drop specks, apply per-filament line weight (thicker wins), then let
// neighbors grow in small steps to fill any gaps (removed specks, hairline seams, thinned lines).
function resolveMulti(L, specs, speck) {
  const all = unionAll(L.map(l => l.cs));
  const sil = all.offset(0.05, 'Miter', 2).offset(-0.05, 'Miter', 2); all.delete();   // closes hairline seams
  let regions = specs.map(g => unionAll(L.filter(l => g.hexes.includes(l.hex)).map(l => l.cs)));
  if (speck > 0) regions = regions.map((r, i) => {
    if (specs[i].kind === 'box' || r.isEmpty()) return r;
    const pieces = r.decompose(), keep = pieces.filter(p => p.area() >= speck);
    const out = unionAll(keep); pieces.forEach(p => p.delete()); r.delete(); return out;
  });
  regions = regions.map((r, i) => { const w = specs[i].weight; if (!w || r.isEmpty()) return r; const o = r.offset(w / 2, 'Round', 2, 8); r.delete(); return o; });
  const order = specs.map((_, i) => i).sort((a, b) => specs[b].weight - specs[a].weight);
  const finals = [];
  // Colors from the SVG never overlap (stacking was resolved on load). Only thickened colors can spill onto their
  // neighbors or past the design's outline, so only then do the (slow) trims run.
  // Thickened colors come first in the order below. Once one exists, later colors are trimmed so nothing overlaps.
  let spill = false, taken = null;
  for (const i of order) {
    const grown = specs[i].weight > 0 && !regions[i].isEmpty();
    let mine = regions[i];
    if (grown) { mine = regions[i].intersect(sil); regions[i].delete(); }
    if (spill && taken) { const m = mine.subtract(taken); mine.delete(); mine = m; }
    finals[i] = mine;
    if (grown) { const t = taken ? taken.add(mine) : mine.translate([0, 0]); taken?.delete(); taken = t; }
    spill = spill || grown;
  }
  taken?.delete();
  const covered = unionAll(finals);
  let gaps = sil.subtract(covered); covered.delete();
  for (const step of [0.08, 0.2, 0.3, 0.4]) {
    if (gaps.isEmpty() || gaps.area() < 1e-4) break;
    // Only the parts of each color right next to a gap can grow into it, so work on just those (much faster).
    const near = gaps.offset(step + 0.01, 'Miter', 2);
    for (const i of order) {
      if (specs[i].weight < 0 || finals[i].isEmpty()) continue;   // a thinned color doesn't grow back
      const local = finals[i].intersect(near);
      if (local.isEmpty()) { local.delete(); continue; }
      const grow = local.offset(step, 'Miter', 2), add = grow.intersect(gaps); grow.delete(); local.delete();
      if (add.isEmpty()) { add.delete(); continue; }
      const nf = finals[i].add(add), ng = gaps.subtract(add); finals[i].delete(); gaps.delete(); add.delete();
      finals[i] = nf; gaps = ng;
    }
    near.delete();
  }
  gaps.delete(); sil.delete();
  return specs.map((g, i) => {
    const cs = g.kind === 'box' ? finals[i] : finals[i].simplify(0.001).offset(-0.004, 'Miter', 2).offset(0.004, 'Miter', 2).simplify(0.0001);
    if (g.kind !== 'box') finals[i].delete();
    return { ...g, cs };
  });
}

// Placement on the face: moved, then trimmed to the face outline. Caller must dispose().
function placedSil(f, s) {
  const base = baseArt(f, s);
  const clip = rectCS(-f.w / 2, -f.h / 2, f.w / 2, f.h / 2), full = base.sil.translate([s.dx, s.dy]);
  const cut = full.intersect(clip); clip.delete(); full.delete();
  return { cut, W: base.W, H: base.H, dispose() { cut.delete(); } };
}
// For export. The clip extends 0.5 mm past the face edge: beyond the edge there's nothing to cut, and letting the
// box's own surface do the trimming avoids coplanar faces (which leave slivers and non-manifold edges).
function placedForExport(f, s) {
  const base = baseArt(f, s), E = 0.5, clip = rectCS(-f.w / 2 - E, -f.h / 2 - E, f.w / 2 + E, f.h / 2 + E);
  const place = cs => { const m = cs.translate([s.dx, s.dy]), cut = m.intersect(clip); m.delete(); return cut; };
  const out = { pocket: place(base.sil), groups: base.groups.map(g => ({ ...g, cs: place(g.cs) })) };
  clip.delete();
  return out;
}
function warningsFor(f, s, p) {
  const out = [];
  if (p.cut.isEmpty()) out.push('The design is completely off this face, so nothing will be cut.');
  const inlays = baseArt(f, s).groups.filter(g => g.kind === 'inlay').length;
  if (inlays && s.depth < 0.4) out.push('Inlays thinner than 0.4 mm (about 2 layers) can let the box color show through. 0.6 mm or more looks solid.');
  if (s.depth > f.wall - 0.4) out.push(`Only ${(f.wall - s.depth).toFixed(2)} mm of wall would be left behind this design. Keep at least 0.4 mm so it doesn't punch through.`);
  for (const z of f.thin) {
    if (s.depth <= z.wall - 0.4) continue;
    const zr = rectCS(...z.r), hit = p.cut.intersect(zr), a = hit.area(); zr.delete(); hit.delete();
    if (a > 0.5) out.push(`Part of the design sits on ${z.what}, where the wall is only ${z.wall} mm. At ${s.depth} mm deep it could break through there. Move it away from the edge or reduce the depth.`);
  }
  return out;
}

/* ---------- Three.js scene ---------- */
const view = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.localClippingEnabled = true;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const canvas = renderer.domElement;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 20, 1200);   // tight near/far = better depth precision for thin walls
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.minDistance = 60; controls.maxDistance = 700;
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6558, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(120, 160, 200); scene.add(sun);
const fillL = new THREE.DirectionalLight(0xffffff, 0.5); fillL.position.set(-150, -40, -120); scene.add(fillL);
// Box coords -> view coords: viewer's right = -x, up = -y, toward viewer = +z (180° about z)
const root = new THREE.Group(); root.rotation.z = Math.PI; root.position.z = -36; scene.add(root);
const inner = new THREE.Group(); root.add(inner);
const boxMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.75, metalness: 0 });
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xb4532a, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
const partMats = {};
const partMat = c => partMats[c] || (partMats[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55 }));
let boxMesh, cutMode = false, cutParts = [];
const decals = {}, ghosts = {}, frames = {};

function resize() {
  const r = view.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
(function loop() { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); })();

function lookAtFace(f, animate = true) {
  const d = f ? new THREE.Vector3(...f.N).applyEuler(root.rotation).normalize() : new THREE.Vector3(0.55, 0.35, 1).normalize();
  const vertical = f && Math.abs(d.y) > 0.9;
  const to = d.clone().multiplyScalar(270).add(new THREE.Vector3(0, vertical ? 0 : 25, vertical ? 40 : 0));
  const tgt = new THREE.Vector3(0, 0, 0);
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { camera.position.copy(to); controls.target.copy(tgt); return; }
  const from = camera.position.clone(), t0 = performance.now();
  (function step(t) {
    const k = Math.min((t - t0) / 450, 1), e = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(from, to, e); controls.target.copy(tgt);
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}

function drawFrame(f) {
  const hw = f.w / 2, hh = f.h / 2, m = new THREE.Matrix4().fromArray(faceMat(f, 0.2));
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], [-hw, -hh]].map(([a, b]) => new THREE.Vector3(a, b, 0).applyMatrix4(m));
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineDashedMaterial({ color: 0xb4532a, dashSize: 2.5, gapSize: 1.8, transparent: true, opacity: 0.9 }));
  line.computeLineDistances(); line.renderOrder = 5;
  frames[f.id] = line; inner.add(line);
  line.visible = f.id === selected;
}

// Each face gets a fixed "face frame" group. Inside it a "mover" holds the design (one mesh per color group) and
// its ghost. Moving/resizing only changes the mover's transform, and trimming to the face is done by GPU clipping
// planes, so slider drags cost almost nothing. Geometry is rebuilt only when the shape itself settles.
const faceGroups = {}, movers = {}, clipPlanes = {}, groupMats = {};
function initFaceGroup(f) {
  const g = new THREE.Group(); g.matrixAutoUpdate = false; g.matrix.fromArray(faceMat(f)); inner.add(g);
  const mover = new THREE.Group(); g.add(mover);
  faceGroups[f.id] = g; movers[f.id] = mover; groupMats[f.id] = {};
  inner.updateMatrixWorld(true); g.updateMatrixWorld(true);
  const M = g.matrixWorld, planes = [];
  for (const [nx, ny, off] of [[-1, 0, f.w / 2], [1, 0, f.w / 2], [0, -1, f.h / 2], [0, 1, f.h / 2]]) {
    const n = new THREE.Vector3(nx, ny, 0), p = new THREE.Vector3(-nx * off, -ny * off, 0);
    planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(n, p).applyMatrix4(M));
  }
  clipPlanes[f.id] = planes;
}
function matFor(f, key) {
  return groupMats[f.id][key] || (groupMats[f.id][key] = new THREE.MeshStandardMaterial({ roughness: 0.6, clippingPlanes: clipPlanes[f.id], polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
}
function clearDecal(id) {
  if (decals[id]) { decals[id].parent?.remove(decals[id]); decals[id].traverse(o => o.geometry?.dispose()); delete decals[id]; }
  if (ghosts[id]) { ghosts[id].parent?.remove(ghosts[id]); ghosts[id].geometry.dispose(); delete ghosts[id]; }
}
function fitOf(f, s) {
  const rot = s.rot % 180 !== 0, w = rot ? s.rh : s.rw, h = rot ? s.rw : s.rh;
  const fit = Math.min(f.w / w, f.h / h) * s.scale / 100;
  return { W: w * fit, H: h * fit };
}
// Full rebuild of one face's preview (geometry is reused when the shape hasn't changed).
function refreshDecal(f) {
  const s = state[f.id];
  if (!s || cutMode) { clearDecal(f.id); return; }
  const base = baseArt(f, s);
  if (!decals[f.id] || decals[f.id].userData.key !== s._key) {
    clearDecal(f.id);
    const grp = new THREE.Group(); grp.position.z = 0.02;
    for (const g of base.groups) {
      const solid = g.cs.extrude(0.12), mesh = new THREE.Mesh(meshToGeo(solid.getMesh()), matFor(f, g.key)); solid.delete();
      mesh.userData = { face: f.id, group: g.key }; grp.add(mesh);
    }
    const gs = base.sil.extrude(0.01), ghost = new THREE.Mesh(meshToGeo(gs.getMesh()), ghostMat); gs.delete();
    ghost.position.z = 0.3; ghost.userData = { face: f.id };
    grp.userData = { face: f.id, key: s._key, rot: s.rot, scale: s.scale, bx: base.bx, by: base.by };
    movers[f.id].add(grp, ghost); decals[f.id] = grp; ghosts[f.id] = ghost;
  }
  updateTransform(f); styleDecal(f);
}
function updateTransform(f) {
  const s = state[f.id], grp = decals[f.id]; if (!s || !grp) return;
  const d = grp.userData;
  if (d.rot !== s.rot) { refreshDecal(f); return; }   // rotation needs a rebuild
  const k = s.scale / d.scale;
  movers[f.id].position.set(s.dx, s.dy, 0); movers[f.id].scale.set(k, k, 1);
  s._trimmed = d.bx[0] * k + s.dx < -f.w / 2 || d.bx[1] * k + s.dx > f.w / 2 || d.by[0] * k + s.dy < -f.h / 2 || d.by[1] * k + s.dy > f.h / 2;
  if (ghosts[f.id]) ghosts[f.id].visible = f.id === selected && s._trimmed;
}
function styleDecal(f) {
  const s = state[f.id]; if (!s) return;
  for (const g of groupSpecs(s)) {
    const m = groupMats[f.id][g.key]; if (!m) continue;
    m.color.set(g.kind === 'inlay' ? g.color : (f.id === selected ? ENGRAVE_SEL : ENGRAVE_COLOR));
  }
  if (ghosts[f.id]) ghosts[f.id].visible = f.id === selected && !!s._trimmed;
}

function setCutMode(on, geo, parts) {
  cutMode = on;
  inner.remove(boxMesh);
  if (boxMesh.geometry !== boxGeo) boxMesh.geometry.dispose();
  boxMesh = new THREE.Mesh(on ? geo : boxGeo, boxMat); inner.add(boxMesh);
  cutParts.forEach(m => { inner.remove(m); m.geometry.dispose(); }); cutParts = [];
  if (on && parts) for (const p of parts) { const m = new THREE.Mesh(p.geo, partMat(p.color)); cutParts.push(m); inner.add(m); }
  FACES.forEach(refreshDecal);
  $('#viewmode').textContent = on ? 'Showing the finished cut' : 'Preview: drag a design to move it · Shift+scroll to resize';
  $('#backToEdit').hidden = !on;
}

/* ---------- Drag designs on the model (a click without dragging picks that color) ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function hitDesign(e) {
  setRay(e);
  const targets = [];
  for (const grp of Object.values(decals)) grp.children.forEach(m => targets.push(m));
  for (const g of Object.values(ghosts)) if (g.visible) targets.push(g);
  if (boxMesh) targets.push(boxMesh);
  // Only what is in front counts, and only the part of a design that isn't clipped away at the face edge.
  for (const h of ray.intersectObjects(targets, false)) {
    if (h.object === boxMesh) return null;
    const planes = h.object.material.clippingPlanes;
    if (planes && planes.some(p => p.distanceToPoint(h.point) < 0)) continue;
    return h.object.userData;
  }
  return null;
}
function facePoint(f, e) {  // pointer -> (u, v) on the face plane, in mm
  setRay(e);
  inner.updateMatrixWorld();
  const n = new THREE.Vector3(...f.N).transformDirection(inner.matrixWorld);
  const c = new THREE.Vector3(...f.c).applyMatrix4(inner.matrixWorld);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, c);
  const p = ray.ray.intersectPlane(plane, new THREE.Vector3());
  if (!p) return null;
  const local = inner.worldToLocal(p).toArray().map((x, i) => x - f.c[i]);
  return [dot(local, f.R), dot(local, f.U)];
}
let drag = null;
canvas.addEventListener('pointerdown', e => {
  if (cutMode || e.button !== 0) return;
  const hit = hitDesign(e); if (!hit?.face) return;
  const f = faceById(hit.face), s = state[hit.face], p0 = facePoint(f, e); if (!p0) return;
  if (selected !== hit.face) select(hit.face, false);
  drag = { f, s, p0, dx0: s.dx, dy0: s.dy, x: e.clientX, y: e.clientY, moved: false, group: hit.group };
  controls.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  e.preventDefault();
});
let dragFrame = 0;
canvas.addEventListener('pointermove', e => {
  if (!drag) { if (!cutMode && e.pointerType === 'mouse') canvas.style.cursor = hitDesign(e) ? 'move' : 'grab'; return; }
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  const p = facePoint(drag.f, e); if (!p) return;
  const lim = (v, m) => Math.max(-m, Math.min(m, v));
  drag.s.dx = +lim(drag.dx0 + p[0] - drag.p0[0], drag.f.w).toFixed(1);
  drag.s.dy = +lim(drag.dy0 + p[1] - drag.p0[1], drag.f.h).toFixed(1);
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (drag) liveUpdate(); });
});
function endDrag() {
  if (!drag) return;
  const { moved, group } = drag; drag = null; controls.enabled = true; canvas.style.cursor = 'grab';
  if (moved) liveUpdate(0);
  else if (group && state[selected]?.multi) flashGroup(group);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
view.addEventListener('wheel', e => {   // Shift+scroll over the model resizes the selected design
  if (!e.shiftKey || cutMode || !state[selected]) return;
  e.preventDefault(); e.stopPropagation();
  const s = state[selected], d = (e.deltaY || e.deltaX) > 0 ? -2 : 2;
  s.scale = Math.max(10, Math.min(300, s.scale + d));
  liveUpdate();
}, { capture: true, passive: false });

/* ---------- UI ---------- */
let selected = 'left';
const list = $('#faces');

function thumbSVG(s) {
  const url = s._thumb || (s._thumb = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.svgText));
  return `<img alt="" src="${url}" style="transform:rotate(${s.rot}deg)">`;
}
const escapeHtml = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function chipHTML(f) {
  const s = state[f.id];
  if (!s) return '<span class="chip empty">Empty</span>';
  const p = placedSil(f, s), warn = warningsFor(f, s, p).length, W = p.W, H = p.H; p.dispose();
  if (warn) return '<span class="chip warn">Check</span>';
  const inl = groupSpecs(s).filter(g => g.kind === 'inlay' && g.hexes.length);
  if (inl.length) return `<span class="chip ok">${inl.map(g => `<i class="dot" style="background:${g.color}"></i>`).join('')}${inl.length > 1 ? `${inl.length} colors` : 'Inlay'}</span>`;
  return `<span class="chip ok">${W.toFixed(0)}×${H.toFixed(0)} mm</span>`;
}
function updateChip(f) {
  const el = document.querySelector(`#face-${f.id} .chip`); if (el) el.outerHTML = chipHTML(f);
}
function renderList() {
  list.innerHTML = FACES.map(f => {
    const s = state[f.id];
    return `<li><button class="face ${f.id === selected ? 'sel' : ''}" data-id="${f.id}" id="face-${f.id}">
      <span class="thumb">${s ? thumbSVG(s) : '<span class="plus">+</span>'}</span>
      <span class="fname">${f.name}<small>${s ? escapeHtml(s.fileName) : 'Drop an SVG here'}</small></span>
      ${chipHTML(f)}</button></li>`;
  }).join('');
  if (!$('#build').disabled) $('#build').textContent = buildLabel();
  list.querySelectorAll('.face').forEach(b => {
    b.onclick = () => select(b.dataset.id);
    b.ondragover = e => { e.preventDefault(); b.classList.add('drag'); };
    b.ondragleave = () => b.classList.remove('drag');
    b.ondrop = e => { e.preventDefault(); b.classList.remove('drag'); const file = e.dataTransfer.files[0]; if (file) loadFile(b.dataset.id, file); };
  });
}

function swapNote(f, s) {
  const inl = groupSpecs(s).filter(g => g.kind === 'inlay' && g.hexes.length).length;
  if (!inl) return '';
  const flat = f.N[2] !== 0, layers = Math.max(1, Math.round(s.depth / LAYER_H));
  if (flat) return `This face prints flat on the bed, so color changes only happen in the first ${layers} layer${layers > 1 ? 's' : ''}. Cheap and clean.`;
  return `This face stands upright when printed, so every layer through the design needs about ${inl} filament change${inl > 1 ? 's' : ''}${inl > 1 ? ' (one per color)' : ''}. It works, but expect more purge and print time than on the back.`;
}
function renderEditor() {
  const f = faceById(selected), s = state[f.id];
  $('#edTitle').textContent = f.name;
  $('#edMeta').textContent = `Face ${f.w.toFixed(0)} × ${f.h.toFixed(0)} mm · wall ${f.wall} mm thick`;
  $('#edEmpty').hidden = !!s; $('#edControls').hidden = !s;
  if (!s) return;
  $('#dx').min = -Math.ceil(f.w); $('#dx').max = Math.ceil(f.w); $('#dy').min = -Math.ceil(f.h); $('#dy').max = Math.ceil(f.h);
  $('#depth').max = Math.max(0.2, +(f.wall - 0.2).toFixed(1));
  document.querySelectorAll('.rot button').forEach(b => b.classList.toggle('on', +b.dataset.rot === s.rot));
  // Single-color designs: Engrave / Color inlay switch. Multi-color designs: the colors panel.
  $('#modeWrap').hidden = s.multi; $('#weightRow').hidden = s.multi; $('#colorsPanel').hidden = !s.multi;
  document.querySelectorAll('.mode button').forEach(b => { b.classList.toggle('on', b.dataset.mode === s.mode); b.setAttribute('aria-pressed', b.dataset.mode === s.mode); });
  $('#inlayRow').hidden = s.multi || s.mode !== 'inlay';
  $('#inlayColor').value = s.color;
  const anyInlay = groupSpecs(s).some(g => g.kind === 'inlay' && g.hexes.length);
  $('#depthLabel').textContent = anyInlay ? 'Inlay depth' : 'Depth';
  $('#swapNote').textContent = swapNote(f, s); $('#swapNote').hidden = !anyInlay;
  if (s.multi) renderColors();
  syncSliders();
}

/* ---------- Colors panel (multi-color SVGs) ---------- */
function renderColors() {
  const f = faceById(selected), s = state[f.id]; if (!s?.multi) return;
  const specs = groupSpecs(s), n = s.layers.length;
  $('#colorsSummary').textContent = `${n} color${n > 1 ? 's' : ''} in this design${s._merged ? ` · merged to ${s.nFil} filament${s.nFil > 1 ? 's' : ''}` : ''}`;
  const free = s.layers.filter(l => !['box', 'engrave'].includes(s.assign[l.hex] || 'box')).length;
  $('#filCount').textContent = s.nFil; $('#filMinus').disabled = s.nFil <= 1; $('#filPlus').disabled = s.nFil >= Math.min(MAX_FILAMENTS, free);
  $('#speck').value = s.speck; $('#speckNum').value = (+s.speck).toFixed(1);
  const options = [...specs.filter(g => g.kind === 'inlay').map(g => [g.key, g.label]), ['box', 'Box color (skip)'], ['engrave', 'Engrave only']];
  const row = l => `<div class="crow"><i class="sw" style="background:${l.hex}"></i><span class="chex">${l.hex}</span><span class="cpct">${(l.area * 100).toFixed(l.area < 0.01 ? 1 : 0)}%</span>
    <select data-hex="${l.hex}" aria-label="Where ${l.hex} goes">${options.map(([k, t]) => `<option value="${k}" ${(s.assign[l.hex] || 'box') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`;
  $('#colorGroups').innerHTML = specs.filter(g => g.hexes.length || g.kind === 'inlay').map(g => {
    const members = s.layers.filter(l => g.hexes.includes(l.hex));
    const head = g.kind === 'inlay'
      ? `<div class="ghead"><input type="color" class="gcolor" data-key="${g.key}" value="${g.color}" aria-label="${g.label} preview color"><b>${g.label}</b>
         <label class="gw">Line weight <input type="number" class="gweight" data-key="${g.key}" step="0.05" value="${(+g.weight).toFixed(2)}"> mm</label></div>`
      : `<div class="ghead"><i class="sw ${g.kind}"></i><b>${g.label}</b><span class="gnote">${g.kind === 'box' ? 'not printed separately' : 'cut, no filament'}</span></div>`;
    return `<div class="cgroup" data-group="${g.key}">${head}${members.map(row).join('') || '<p class="gempty">No colors assigned</p>'}</div>`;
  }).join('');
  $('#colorGroups').querySelectorAll('select').forEach(sel => sel.onchange = () => { s.assign[sel.dataset.hex] = sel.value; s._merged = false; colorsChanged(); });
  $('#colorGroups').querySelectorAll('.gcolor').forEach(inp => inp.addEventListener('input', () => {
    s.fils[+inp.dataset.key.slice(1) - 1].color = inp.value; styleDecal(f);
    clearTimeout(settleTimer); settleTimer = setTimeout(() => updateChip(f), 150);
  }));
  $('#colorGroups').querySelectorAll('.gweight').forEach(inp => inp.addEventListener('change', () => {
    const v = +inp.value; if (!isFinite(v)) return; s.fils[+inp.dataset.key.slice(1) - 1].weight = Math.max(-1, Math.min(2, v)); colorsChanged(false);
  }));
}
function colorsChanged(rerender = true) {
  const f = faceById(selected);
  if (rerender) renderColors();
  if (cutMode) setCutMode(false);
  refreshDecal(f); updateWarnings(); updateChip(f);
  const s = state[f.id];
  const anyInlay = groupSpecs(s).some(g => g.kind === 'inlay' && g.hexes.length);
  $('#swapNote').textContent = swapNote(f, s); $('#swapNote').hidden = !anyInlay;
  $('#build').textContent = buildLabel();
}
function flashGroup(key) {
  const el = document.querySelector(`.cgroup[data-group="${key}"]`); if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
$('#filMinus').onclick = () => { const s = state[selected]; if (!s?.multi || s.nFil <= 1) return; autoAssign(s, s.nFil - 1); s._merged = true; colorsChanged(); };
$('#filPlus').onclick = () => { const s = state[selected]; if (!s?.multi || s.nFil >= MAX_FILAMENTS) return; autoAssign(s, s.nFil + 1); s._merged = s.layers.length > s.nFil; colorsChanged(); };
$('#autoColors').onclick = () => {
  const s = state[selected]; if (!s?.multi) return;
  s.assign = {}; const bg = detectBackground(s.layers, s.rw, s.rh); if (bg) s.assign[bg] = 'box';
  autoAssign(s, MAX_FILAMENTS); s._merged = s.layers.filter(l => s.assign[l.hex] !== 'box').length > s.nFil; colorsChanged();
};
const setSpeck = v => { const s = state[selected]; if (!s?.multi || !isFinite(v)) return; s.speck = Math.max(0, Math.min(5, v)); $('#speckNum').value = s.speck.toFixed(1); $('#speck').value = s.speck;
  clearTimeout(settleTimer); settleTimer = setTimeout(() => colorsChanged(false), 250); };
$('#speck').addEventListener('input', e => setSpeck(+e.target.value));
$('#speckNum').addEventListener('change', e => setSpeck(+e.target.value));

const FIELDS = ['scale', 'dx', 'dy', 'weight', 'depth'];
const fmt = { scale: v => String(Math.round(v)), dx: v => (+v).toFixed(1), dy: v => (+v).toFixed(1), weight: v => (+v).toFixed(2), depth: v => (+v).toFixed(1) };
function syncControls() {   // cheap: slider/number values and the size readout
  const f = faceById(selected), s = state[f.id]; if (!s) return;
  for (const k of FIELDS) {
    $('#' + k).value = s[k];
    const n = $('#' + k + 'Num'); if (document.activeElement !== n) n.value = fmt[k](s[k]);
  }
  const { W, H } = fitOf(f, s);
  $('#sizeOut').textContent = `${W.toFixed(1)} × ${H.toFixed(1)} mm${s._trimmed ? ' · trimmed' : ''}`;
}
function updateWarnings() { // heavier: runs after changes settle
  const f = faceById(selected), s = state[f.id]; if (!s) return;
  const p = placedSil(f, s), warns = warningsFor(f, s, p); p.dispose();
  $('#warn').hidden = !warns.length; $('#warn').innerHTML = warns.map(w => `<p>${w}</p>`).join('');
}
function syncSliders() { syncControls(); updateWarnings(); }

function select(id, move = true) {
  const prev = selected; selected = id;
  FACES.forEach(f => { if (frames[f.id]) frames[f.id].visible = f.id === id; });
  if (prev !== id && state[prev] && faceById(prev)) { styleDecal(faceById(prev)); updateTransform(faceById(prev)); }
  if (state[id]) { styleDecal(faceById(id)); updateTransform(faceById(id)); }
  renderList(); renderEditor();
  if (move) lookAtFace(faceById(id));
}

function disposeArt(s) { s.layers.forEach(l => l.cs.delete()); if (s._base) disposeBase(s._base); }
function setArt(id, fileName, text, scale = DEFAULT_SCALE) {
  const f = faceById(id);
  const r = parseSVG(text);
  const old = state[id];
  const s = { uid: ++artCounter, fileName, svgText: text, layers: r.layers, rw: r.rw, rh: r.rh, scale, dx: 0, dy: 0, rot: 0, depth: f.depth, weight: 0,
    mode: old?.mode || 'engrave', color: old?.color || INLAY_COLORS[FACES.indexOf(f) % INLAY_COLORS.length], multi: false, speck: 0 };
  if (r.layers.length > 1) {
    // Multi-color: background becomes box color, the rest is merged down to the AMS slot count.
    s.multi = true; s.speck = 0.3; s.assign = {};
    const bg = detectBackground(r.layers, r.rw, r.rh); if (bg) s.assign[bg] = 'box';
    autoAssign(s, MAX_FILAMENTS);
    s._merged = r.layers.filter(l => s.assign[l.hex] !== 'box').length > s.nFil;
    s.depth = Math.max(f.depth, Math.min(0.6, f.wall - 0.45));   // inlays look solid at ~3 layers
  }
  state[id] = s;
  if (old) disposeArt(old);
  return r;
}
async function loadFile(id, file) {
  try {
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new Error(`${file.name} isn't an SVG file.`);
    const r = setArt(id, file.name, await file.text());
    if (cutMode) setCutMode(false);
    const s = state[id], notes = [];
    if (s.multi) {
      const bg = Object.values(s.assign).includes('box');
      notes.push(`${r.layers.length} colors found${s._merged ? `, merged to ${s.nFil} filaments` : ''}${bg ? ', background set to box color' : ''}`);
    }
    if (r.gradients) notes.push('gradients flattened to one color');
    if (r.skippedOutlines) notes.push(`skipped ${r.skippedOutlines} empty path(s)`);
    toast(`Loaded ${file.name} on the ${faceById(id).name.toLowerCase()}${notes.length ? ': ' + notes.join('; ') : ''}.`);
    refreshDecal(faceById(id));
    select(id);
  } catch (e) { toast(e.message, true); }
}

// Instant part: move/scale the existing preview. Settled part (after a short pause): rebuild geometry if
// the shape changed, re-check warnings, update the face's chip in the list.
let settleTimer = 0;
function liveUpdate(delay = 180) {
  if (cutMode) setCutMode(false);
  const f = faceById(selected);
  updateTransform(f); styleDecal(f); syncControls();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    refreshDecal(f); syncControls(); updateWarnings(); updateChip(f);
    const s = state[f.id]; if (s) { $('#swapNote').textContent = swapNote(f, s); }
  }, delay);
}
const scheduleRefresh = () => liveUpdate(0);
const LIMITS = { scale: [5, 500], weight: [-1, 3] };
function setField(k, v) {
  const f = faceById(selected), s = state[f.id]; if (!s || !isFinite(v)) return;
  const lim = { ...LIMITS, dx: [-f.w, f.w], dy: [-f.h, f.h], depth: [0.1, Math.max(0.2, f.wall - 0.1)] }[k];
  s[k] = Math.max(lim[0], Math.min(lim[1], v));
  liveUpdate();
}
for (const k of FIELDS) {
  $('#' + k).addEventListener('input', e => setField(k, +e.target.value));
  const n = $('#' + k + 'Num');
  n.addEventListener('input', e => { if (e.target.value !== '' && e.target.value !== '-') setField(k, +e.target.value); });
  n.addEventListener('change', () => { syncControls(); });   // tidy the number after typing (clamped/rounded)
  n.addEventListener('keydown', e => { if (e.key === 'Enter') n.blur(); });
}
$('#reset').onclick = () => {
  const f = faceById(selected), s = state[f.id]; if (!s) return;
  Object.assign(s, { scale: DEFAULT_SCALE, dx: 0, dy: 0, rot: 0, weight: 0, depth: s.multi ? Math.max(f.depth, Math.min(0.6, f.wall - 0.45)) : f.depth });
  if (s.multi) s.fils.forEach(x => x.weight = 0);
  renderEditor(); liveUpdate(0);
};
document.querySelectorAll('.rot button').forEach(b => b.onclick = () => {
  const s = state[selected]; if (!s) return; s.rot = +b.dataset.rot; renderEditor(); scheduleRefresh();
});
$('#center').onclick = () => { const s = state[selected]; if (!s) return; s.dx = 0; s.dy = 0; renderEditor(); scheduleRefresh(); };
$('#fitBtn').onclick = () => { const s = state[selected]; if (!s) return; s.scale = 100; s.dx = 0; s.dy = 0; renderEditor(); scheduleRefresh(); };
$('#remove').onclick = () => {
  const s = state[selected]; if (!s) return; disposeArt(s); delete state[selected];
  if (cutMode) setCutMode(false);
  refreshDecal(faceById(selected)); renderList(); renderEditor();
};
document.querySelectorAll('.mode button').forEach(b => b.onclick = () => {
  const s = state[selected]; if (!s) return; s.mode = b.dataset.mode; renderEditor(); scheduleRefresh(); updateChip(faceById(selected)); $('#build').textContent = buildLabel();
});
$('#inlayColor').addEventListener('input', e => { const s = state[selected]; if (!s) return; s.color = e.target.value; styleDecal(faceById(selected)); clearTimeout(settleTimer); settleTimer = setTimeout(() => updateChip(faceById(selected)), 150); });
$('#pick').onclick = () => $('#file').click();
$('#file').onchange = e => { const file = e.target.files[0]; if (file) loadFile(selected, file); e.target.value = ''; };
view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drag'); });
view.addEventListener('dragleave', () => view.classList.remove('drag'));
view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('drag'); const file = e.dataTransfer.files[0]; if (file) loadFile(selected, file); });
$('#overview').onclick = () => lookAtFace(null);
$('#backToEdit').onclick = () => setCutMode(false);
document.addEventListener('keydown', e => {   // arrow keys nudge the selected design (Shift = 5 mm)
  const ae = document.activeElement;
  if (!state[selected] || cutMode || /INPUT|TEXTAREA|SELECT/.test(ae?.tagName)) return;
  const step = e.shiftKey ? 5 : 0.5, s = state[selected];
  const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (!m) return;
  e.preventDefault(); s.dx = +(s.dx + m[0]).toFixed(1); s.dy = +(s.dy + m[1]).toFixed(1); liveUpdate();
});

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, bad ? 7000 : 4500);
}

/* ---------- Build ---------- */
const hasInlay = () => FACES.some(f => state[f.id] && groupSpecs(state[f.id]).some(g => g.kind === 'inlay' && g.hexes.length));
const buildLabel = () => hasInlay() ? 'Download 3MF (multi-color)' : 'Download STL';

// Returns { body: Manifold, parts: [{ name, color, man }] }. Inlay parts are pocket volumes, clipped to the box.
function buildModel() {
  const cutters = [], inlays = [];
  for (const f of FACES) {
    const s = state[f.id]; if (!s) continue;
    const { pocket, groups } = placedForExport(f, s);
    const extrude = cs => cs.extrude(s.depth + 1).translate([0, 0, -s.depth]).transform(faceMat(f));
    if (!pocket.isEmpty()) cutters.push(extrude(pocket));   // the box loses the whole pocket in one piece
    pocket.delete();
    for (const g of groups) {
      if (g.kind === 'inlay' && !g.cs.isEmpty()) inlays.push({ f, s, g, c: extrude(g.cs) });
      g.cs.delete();
    }
  }
  if (!cutters.length) return null;
  const all = wasm.Manifold.union(cutters);
  const body = boxManifold.subtract(all).simplify(0.001);   // drop sub-micron slivers so the mesh stays watertight
  all.delete();
  // Colors on the same face are already separate. Parts from different faces can meet at a corner, so each face's
  // parts give way to earlier faces' parts there.
  const parts = []; let taken = null, faceTaken = null, curFace = null;
  for (const { f, s, g, c } of inlays) {
    if (f !== curFace) {
      if (faceTaken) { const t = taken ? taken.add(faceTaken) : faceTaken.translate([0, 0, 0]); taken?.delete(); faceTaken.delete(); taken = t; faceTaken = null; }
      curFace = f;
    }
    let m = boxManifold.intersect(c);                          // only what is inside the box
    if (taken) { const t = m.subtract(taken); m.delete(); m = t; }
    const nf = faceTaken ? faceTaken.add(m) : m.translate([0, 0, 0]); faceTaken?.delete(); faceTaken = nf;
    m = m.simplify(0.001);
    const design = s.fileName.replace(/\.svg$/i, '');
    const name = s.multi ? `${design} (${f.name}) - ${g.label} ${g.color}` : `${design} (${f.name})`;
    if (!m.isEmpty()) parts.push({ name, color: g.color, man: m });
  }
  taken?.delete(); faceTaken?.delete();
  cutters.forEach(c => c.delete()); inlays.forEach(x => x.c.delete());
  return { body, parts };
}

/* ---------- 3MF (zip) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
  catch { return null; }
}
async function makeZip(files) {   // files: [[name, Uint8Array]]
  const enc = new TextEncoder(), chunks = [], central = []; let offset = 0;
  for (const [name, data] of files) {
    const nb = enc.encode(name), crc = crc32(data), comp = await deflate(data), method = comp ? 8 : 0, body = comp || data;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, method, true);
    h.setUint32(14, crc, true); h.setUint32(18, body.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    chunks.push(new Uint8Array(h.buffer), nb, body);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(10, method, true);
    c.setUint32(16, crc, true); c.setUint32(20, body.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nb);
    offset += 30 + nb.length + body.length;
  }
  const csize = central.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(e.buffer)], { type: 'model/3mf' });
}
const xmlEsc = t => t.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function meshXML(id, name, mesh) {
  const v = mesh.vertProperties, t = mesh.triVerts, out = [`<object id="${id}" name="${xmlEsc(name)}" type="model"><mesh><vertices>`];
  for (let i = 0; i < v.length; i += 3) out.push(`<vertex x="${+v[i].toFixed(5)}" y="${+v[i+1].toFixed(5)}" z="${+v[i+2].toFixed(5)}"/>`);
  out.push('</vertices><triangles>');
  for (let i = 0; i < t.length; i += 3) out.push(`<triangle v1="${t[i]}" v2="${t[i+1]}" v3="${t[i+2]}"/>`);
  out.push('</triangles></mesh></object>');
  return out.join('');
}
async function write3MF(name, body, parts) {
  // One object made of several parts: slicers (Bambu Studio, OrcaSlicer, PrusaSlicer) load these as parts you can assign filaments to.
  const objs = [meshXML(1, 'Box', body.getMesh())];
  parts.forEach((p, i) => objs.push(meshXML(i + 2, p.name, p.man.getMesh())));
  const groupId = parts.length + 2;
  const comps = [1, ...parts.map((_, i) => i + 2)].map(id => `<component objectid="${id}"/>`).join('');
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${xmlEsc(name)}</metadata><metadata name="Application">Deck Box Engraver</metadata>
<resources>${objs.join('\n')}
<object id="${groupId}" name="${xmlEsc(name)}" type="model"><components>${comps}</components></object>
</resources><build><item objectid="${groupId}"/></build></model>`;
  const enc = new TextEncoder();
  return makeZip([
    ['[Content_Types].xml', enc.encode('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')],
    ['_rels/.rels', enc.encode('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')],
    ['3D/3dmodel.model', enc.encode(model)],
  ]);
}

function download(blob, filename) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#build').onclick = async () => {
  const btn = $('#build');
  if (!FACES.some(f => state[f.id])) { toast('Add at least one SVG first.', true); return; }
  btn.disabled = true; btn.textContent = 'Cutting…';
  await new Promise(r => setTimeout(r, 30));
  let model;
  try {
    const t0 = performance.now();
    model = buildModel();
    if (!model) throw new Error('None of the designs are on the box, so there is nothing to cut.');
    const { body, parts } = model;
    if (body.status() !== 'NoError') throw new Error('The cut failed: ' + body.status());
    const bodyMesh = body.getMesh();
    setCutMode(true, meshToGeo(bodyMesh), parts.map(p => ({ color: p.color, geo: meshToGeo(p.man.getMesh()) })));
    const name = ($('#deckName').value.trim() || 'Deck Box').replace(/[\\/:*?"<>|]/g, '');
    let blob, file;
    if (parts.length) { blob = await write3MF(name, body, parts); file = `${name}.3mf`; }
    else { blob = new Blob([writeSTL(bodyMesh)], { type: 'model/stl' }); file = `${name}.stl`; }
    download(blob, file);
    const extra = parts.length ? ` with ${parts.length} color part${parts.length > 1 ? 's' : ''}` : '';
    toast(`Saved ${file}${extra} (${(blob.size / 1048576).toFixed(1)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) { toast(e.message || String(e), true); }
  if (model) { model.body.delete(); model.parts.forEach(p => p.man.delete()); }
  btn.disabled = false; btn.textContent = buildLabel();
};

/* ---------- Box model loading / switching ---------- */
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function loadProfile(p) {
  // Tear down the previous box (if any). Designs stay on faces that exist in the new box.
  for (const f of FACES) {
    clearDecal(f.id);
    if (frames[f.id]) { inner.remove(frames[f.id]); frames[f.id].geometry.dispose(); delete frames[f.id]; }
    if (faceGroups[f.id]) { inner.remove(faceGroups[f.id]); delete faceGroups[f.id]; }
    Object.values(groupMats[f.id] || {}).forEach(m => m.dispose());
  }
  if (boxMesh) { inner.remove(boxMesh); boxMesh.geometry.dispose(); }
  if (boxManifold) boxManifold.delete();
  cutParts.forEach(m => { inner.remove(m); m.geometry.dispose(); }); cutParts = []; cutMode = false;
  profile = p;
  FACES = p.faces.map(f => ({ ...f, R: cross(f.U, f.N) }));
  // Designs on faces this box doesn't have are kept (hidden) and come back when you switch back.
  for (const s of Object.values(state)) if (s._base) { disposeBase(s._base); s._base = null; s._key = null; }
  const stl = window.__BOXES__[p.stl];
  boxManifold = toManifold(parseSTL(b64(stl).buffer));
  boxGeo = meshToGeo(boxManifold.getMesh());
  boxMesh = new THREE.Mesh(boxGeo, boxMat); inner.add(boxMesh);
  FACES.forEach(drawFrame); FACES.forEach(initFaceGroup);
  FACES.forEach(refreshDecal);
  if (!faceById(selected)) selected = FACES[0].id;
  $('#backToEdit').hidden = true;
}
const profSel = $('#profile');
profSel.innerHTML = PROFILES.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
$('#profileRow').hidden = PROFILES.length < 2;
profSel.onchange = () => {
  const p = PROFILES.find(x => x.id === profSel.value); if (!p || p === profile) return;
  loadProfile(p); select(selected, false); lookAtFace(null);
  toast(`Switched to ${p.name}.`);
};

/* ---------- Boot ---------- */
(async () => {
  wasm = await Module({ wasmBinary: b64(window.__WASM__) });
  wasm.setup();
  FACES = PROFILES[0].faces.map(f => ({ ...f, R: cross(f.U, f.N) }));
  for (const [id, file, text] of window.__SAMPLE__) { try { setArt(id, file, text); } catch (e) { console.warn(e); } }
  loadProfile(PROFILES[0]);
  resize(); lookAtFace(null, false);
  select('left', false);
  $('#viewmode').textContent = 'Preview: drag a design to move it · Shift+scroll to resize';
  document.body.classList.remove('loading');
})().catch(e => { $('#loadingMsg').textContent = 'Could not start: ' + e.message; console.error(e); });
