import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import Module from 'manifold-3d/manifold.js';

/* ---------- Box geometry (box coords: lying on its back, front = +z, top = -y) ---------- */
// Each face: outward normal N, art "up" U, center c of the full face, full face size (w along R, h along U),
// wall thickness behind the face, default depth, and thin strips (local rects) where the wall is thinner.
const X = 39.67, Y = 51.82;
const FACES = [
  { id: 'left',   name: 'Left side',  N: [1, 0, 0],  U: [0, -1, 0], c: [X, 0, 36.175],  w: 72.85, h: 103.64, wall: 3.77, depth: 1.0,
    thin: [{ r: [31.3, -52, 37, 52], wall: 1.32, what: 'the lid rail along the front edge' }] },
  { id: 'right',  name: 'Right side', N: [-1, 0, 0], U: [0, -1, 0], c: [-X, 0, 36.175], w: 72.85, h: 103.64, wall: 3.77, depth: 1.0,
    thin: [{ r: [-37, -52, -31.3, 52], wall: 1.32, what: 'the lid rail along the front edge' }] },
  { id: 'back',   name: 'Back',       N: [0, 0, -1], U: [0, -1, 0], c: [0, 0, -0.25],   w: 79.34, h: 103.64, wall: 1.05, depth: 0.5, thin: [] },
  { id: 'top',    name: 'Top',        N: [0, -1, 0], U: [0, 0, -1], c: [0, -Y, 34.375], w: 79.34, h: 69.25, wall: 5.3,  depth: 1.0, thin: [] },
  { id: 'bottom', name: 'Bottom',     N: [0, 1, 0],  U: [0, 0, 1],  c: [0, Y, 36.175],  w: 79.34, h: 72.85, wall: 4.05, depth: 1.0,
    thin: [{ r: [-40, 31.3, 40, 37], wall: 1.32, what: 'the lid rail along the front edge' }] },
];
const DEFAULT_SCALE = 85;
const INLAY_COLORS = ['#c9a23a', '#3d6b4f', '#1f1f1f', '#8a2f2a', '#2c4f7c'];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
FACES.forEach(f => { f.R = cross(f.U, f.N); });
const faceMat = (f, lift = 0) => [
  ...f.R, 0, ...f.U, 0, ...f.N, 0,
  f.c[0] + f.N[0]*lift, f.c[1] + f.N[1]*lift, f.c[2] + f.N[2]*lift, 1];
const faceById = id => FACES.find(f => f.id === id);

const $ = s => document.querySelector(s);
const state = {};  // face id -> { fileName, svgText, raw, rw, rh, scale, dx, dy, rot, depth, weight, _key, _base }
let wasm, boxManifold, boxGeo;
const rectCS = (x0, y0, x1, y1) => new wasm.CrossSection([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);

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

/* ---------- SVG -> CrossSection ---------- */
function svgToCross(text) {
  const data = new SVGLoader().parse(text);
  const parts = []; let skipped = 0;
  for (const p of data.paths) {
    const st = p.userData?.style || {};
    if (st.fill === 'none' || st.fill === 'transparent') { skipped++; continue; }
    const rings = [];
    for (const sp of p.subPaths) {
      const pts = sp.getPoints(16);
      if (pts.length < 3) continue;
      rings.push(pts.map(q => [q.x, -q.y]));   // SVG y points down
    }
    if (rings.length) parts.push(new wasm.CrossSection(rings, st.fillRule === 'evenodd' ? 'EvenOdd' : 'NonZero'));
  }
  if (!parts.length) throw new Error(skipped ? 'This SVG only has outlines (no filled shapes). In Inkscape use Path → Stroke to Path, then save.' : 'No shapes found in this SVG.');
  const cs = wasm.CrossSection.union(parts);
  parts.forEach(p => p.delete());
  const b = cs.bounds();
  if (!(b.max[0] > b.min[0])) throw new Error('No shapes found in this SVG.');
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const s = 1 / Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
  const norm = cs.translate([-cx, -cy]).scale([s, s]);   // largest side = 1 unit, centered
  const nb = norm.bounds();
  return { raw: norm, rw: nb.max[0] - nb.min[0], rh: nb.max[1] - nb.min[1], skipped };
}

// Rotated + scaled + line-weight-adjusted art, centered at the origin (cached; only rebuilt when those change).
function baseArt(f, s) {
  const key = `${s.rot}|${s.scale}|${s.weight}`;
  if (s._key === key) return s._base;
  const rot = s.rot % 180 !== 0;
  const w = rot ? s.rh : s.rw, h = rot ? s.rw : s.rh;
  const fit = Math.min(f.w / w, f.h / h) * s.scale / 100;
  let cs = s.raw.rotate(-s.rot).scale([fit, fit]);
  // weight = total change in line width. The extra 0.005 mm merges shapes that touch at a single point,
  // which would otherwise leave zero-width pinches (non-manifold edges) in the STL.
  cs = (s.weight ? cs.offset(s.weight / 2 + 0.005, 'Round', 2, 12) : cs.offset(0.005, 'Miter', 2)).simplify(0.01);
  const b = cs.bounds();
  if (s._base) s._base.cs.delete();
  s._base = { cs, W: w * fit, H: h * fit, bx: [b.min[0], b.max[0]], by: [b.min[1], b.max[1]] };
  s._key = key;
  return s._base;
}
// Final placement on the face: moved, then trimmed to the face outline.
function placed(f, s) {
  const base = baseArt(f, s);
  const full = base.cs.translate([s.dx, s.dy]);
  const clip = rectCS(-f.w / 2, -f.h / 2, f.w / 2, f.h / 2);
  const cut = full.intersect(clip); clip.delete();
  const trimmed = base.bx[0] + s.dx < -f.w / 2 || base.bx[1] + s.dx > f.w / 2 || base.by[0] + s.dy < -f.h / 2 || base.by[1] + s.dy > f.h / 2;
  return { full, cut, W: base.W, H: base.H, trimmed };
}
function warningsFor(f, s, p) {
  const out = [];
  if (p.cut.isEmpty()) out.push('The design is completely off this face, so nothing will be cut.');
  if (s.mode === 'inlay' && s.depth < 0.4) out.push('Inlays thinner than 0.4 mm (about 2 layers) can let the box color show through. 0.6 mm or more looks solid.');
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
const camera = new THREE.PerspectiveCamera(32, 1, 1, 2000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6558, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(120, 160, 200); scene.add(sun);
const fillL = new THREE.DirectionalLight(0xffffff, 0.5); fillL.position.set(-150, -40, -120); scene.add(fillL);
// Box coords -> view coords: viewer's right = -x, up = -y, toward viewer = +z (180° about z)
const root = new THREE.Group(); root.rotation.z = Math.PI; root.position.z = -36; scene.add(root);
const inner = new THREE.Group(); root.add(inner);
const boxMat = new THREE.MeshStandardMaterial({ color: 0xd9d4c7, roughness: 0.75, metalness: 0 });
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xb4532a, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
const inlayMats = {};
const inlayMat = c => inlayMats[c] || (inlayMats[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
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

// Each face gets a fixed "face frame" group. Inside it a "mover" holds the design mesh and its ghost.
// Moving/resizing only changes the mover's transform, and trimming to the face is done by GPU clipping
// planes, so slider drags cost almost nothing. Geometry is rebuilt only when rotation/size/line weight settle.
const faceGroups = {}, movers = {}, decalMats = {};
function initFaceGroup(f) {
  const g = new THREE.Group(); g.matrixAutoUpdate = false; g.matrix.fromArray(faceMat(f)); inner.add(g);
  const mover = new THREE.Group(); g.add(mover);
  faceGroups[f.id] = g; movers[f.id] = mover;
  // Clipping planes (world space) that keep only what lies inside the face outline.
  inner.updateMatrixWorld(true); g.updateMatrixWorld(true);
  const M = g.matrixWorld, planes = [];
  for (const [nx, ny, off] of [[-1, 0, f.w / 2], [1, 0, f.w / 2], [0, -1, f.h / 2], [0, 1, f.h / 2]]) {
    const n = new THREE.Vector3(nx, ny, 0), p = new THREE.Vector3(-nx * off, -ny * off, 0);
    planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(n, p).applyMatrix4(M));
  }
  decalMats[f.id] = new THREE.MeshStandardMaterial({ roughness: 0.6, clippingPlanes: planes, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
}
function clearMesh(store, id) {
  if (store[id]) { store[id].parent?.remove(store[id]); store[id].geometry.dispose(); delete store[id]; }
}
function fitOf(f, s) {
  const rot = s.rot % 180 !== 0, w = rot ? s.rh : s.rw, h = rot ? s.rw : s.rh;
  const fit = Math.min(f.w / w, f.h / h) * s.scale / 100;
  return { W: w * fit, H: h * fit };
}
// Full rebuild of one face's preview (geometry is reused when rotation/size/weight haven't changed).
function refreshDecal(f) {
  const s = state[f.id];
  if (!s || cutMode) { clearMesh(decals, f.id); clearMesh(ghosts, f.id); return; }
  const base = baseArt(f, s);
  if (!decals[f.id] || decals[f.id].userData.key !== s._key) {
    clearMesh(decals, f.id); clearMesh(ghosts, f.id);
    const solid = base.cs.extrude(0.12), geo = meshToGeo(solid.getMesh()); solid.delete();
    const mesh = new THREE.Mesh(geo, decalMats[f.id]); mesh.position.z = 0.02;
    const ghost = new THREE.Mesh(geo, ghostMat); ghost.position.z = 0.3;
    mesh.userData = { face: f.id, key: s._key, scale: s.scale, bx: base.bx, by: base.by };
    ghost.userData = { face: f.id };
    movers[f.id].add(mesh, ghost); decals[f.id] = mesh; ghosts[f.id] = ghost;
  }
  updateTransform(f); styleDecal(f);
}
function updateTransform(f) {
  const s = state[f.id], mesh = decals[f.id]; if (!s || !mesh) return;
  const d = mesh.userData;
  if (d.key.split('|')[0] !== String(s.rot)) { refreshDecal(f); return; }   // rotation needs a rebuild
  const k = s.scale / d.scale;
  movers[f.id].position.set(s.dx, s.dy, 0); movers[f.id].scale.set(k, k, 1);
  s._trimmed = d.bx[0] * k + s.dx < -f.w / 2 || d.bx[1] * k + s.dx > f.w / 2 || d.by[0] * k + s.dy < -f.h / 2 || d.by[1] * k + s.dy > f.h / 2;
  if (ghosts[f.id]) ghosts[f.id].visible = f.id === selected && s._trimmed;
}
function styleDecal(f) {
  const s = state[f.id]; if (!s) return;
  decalMats[f.id].color.set(s.mode === 'inlay' ? s.color : (f.id === selected ? 0xb4532a : 0x2f5d50));
  if (ghosts[f.id]) ghosts[f.id].visible = f.id === selected && !!s._trimmed;
}

function setCutMode(on, geo, parts) {
  cutMode = on;
  inner.remove(boxMesh);
  if (boxMesh.geometry !== boxGeo) boxMesh.geometry.dispose();
  boxMesh = new THREE.Mesh(on ? geo : boxGeo, boxMat); inner.add(boxMesh);
  cutParts.forEach(m => { inner.remove(m); m.geometry.dispose(); }); cutParts = [];
  if (on && parts) for (const p of parts) { const m = new THREE.Mesh(p.geo, inlayMat(p.color)); cutParts.push(m); inner.add(m); }
  FACES.forEach(refreshDecal);
  $('#viewmode').textContent = on ? 'Showing the finished cut' : 'Preview: drag a design to move it · Shift+scroll to resize';
  $('#backToEdit').hidden = !on;
}

/* ---------- Drag designs on the model ---------- */
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function hitDesign(e) {
  setRay(e);
  const targets = [...Object.values(decals), ...Object.values(ghosts)].filter(m => m.visible);
  if (boxMesh) targets.push(boxMesh);
  const hits = ray.intersectObjects(targets, false);
  // Only a design that is in front (not hidden behind the box) counts.
  const h = hits[0];
  return h && h.object.userData.face ? h.object.userData.face : null;
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
  const id = hitDesign(e); if (!id) return;
  const f = faceById(id), s = state[id], p0 = facePoint(f, e); if (!p0) return;
  if (selected !== id) select(id, false);
  drag = { f, s, p0, dx0: s.dx, dy0: s.dy, pid: e.pointerId };
  controls.enabled = false; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  e.preventDefault();
});
let dragFrame = 0;
canvas.addEventListener('pointermove', e => {
  if (!drag) { if (!cutMode && e.pointerType === 'mouse') canvas.style.cursor = hitDesign(e) ? 'move' : 'grab'; return; }
  const p = facePoint(drag.f, e); if (!p) return;
  const lim = (v, m) => Math.max(-m, Math.min(m, v));
  drag.s.dx = +lim(drag.dx0 + p[0] - drag.p0[0], drag.f.w).toFixed(1);
  drag.s.dy = +lim(drag.dy0 + p[1] - drag.p0[1], drag.f.h).toFixed(1);
  if (!dragFrame) dragFrame = requestAnimationFrame(() => { dragFrame = 0; if (drag) liveUpdate(); });
});
function endDrag() {
  if (!drag) return;
  const f = drag.f; drag = null; controls.enabled = true; canvas.style.cursor = 'grab';
  liveUpdate(0);
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
  const p = placed(f, s), warn = warningsFor(f, s, p).length; p.full.delete(); p.cut.delete();
  if (warn) return '<span class="chip warn">Check</span>';
  return `<span class="chip ok">${s.mode === 'inlay' ? `<i class="dot" style="background:${s.color}"></i>Inlay` : `${p.W.toFixed(0)}×${p.H.toFixed(0)} mm`}</span>`;
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

function renderEditor() {
  const f = faceById(selected), s = state[f.id];
  $('#edTitle').textContent = f.name;
  $('#edMeta').textContent = `Face ${f.w.toFixed(0)} × ${f.h.toFixed(0)} mm · wall ${f.wall} mm thick`;
  $('#edEmpty').hidden = !!s; $('#edControls').hidden = !s;
  if (!s) return;
  $('#dx').min = -Math.ceil(f.w); $('#dx').max = Math.ceil(f.w); $('#dy').min = -Math.ceil(f.h); $('#dy').max = Math.ceil(f.h);
  $('#depth').max = Math.max(0.2, +(f.wall - 0.2).toFixed(1));
  document.querySelectorAll('.rot button').forEach(b => b.classList.toggle('on', +b.dataset.rot === s.rot));
  document.querySelectorAll('.mode button').forEach(b => { b.classList.toggle('on', b.dataset.mode === s.mode); b.setAttribute('aria-pressed', b.dataset.mode === s.mode); });
  $('#inlayRow').hidden = s.mode !== 'inlay';
  $('#inlayColor').value = s.color;
  $('#depthLabel').textContent = s.mode === 'inlay' ? 'Inlay depth' : 'Depth';
  $('#inlayNote').textContent = f.N[2] !== 0
    ? 'This face prints flat on the bed, so the color only changes for the first few layers. Cheap and clean.'
    : 'This face stands upright when printed, so every layer through the design needs a color swap. It works, but expect more purge waste and print time than an inlay on the back.';
  syncSliders();
}
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
  const p = placed(f, s), warns = warningsFor(f, s, p); p.full.delete(); p.cut.delete();
  $('#warn').hidden = !warns.length; $('#warn').innerHTML = warns.map(w => `<p>${w}</p>`).join('');
}
function syncSliders() { syncControls(); updateWarnings(); }

function select(id, move = true) {
  const prev = selected; selected = id;
  FACES.forEach(f => { if (frames[f.id]) frames[f.id].visible = f.id === id; });
  if (prev !== id && state[prev]) { styleDecal(faceById(prev)); updateTransform(faceById(prev)); }
  if (state[id]) { styleDecal(faceById(id)); updateTransform(faceById(id)); }
  renderList(); renderEditor();
  if (move) lookAtFace(faceById(id));
}

function setArt(id, fileName, text, scale = DEFAULT_SCALE) {
  const f = faceById(id);
  const r = svgToCross(text);
  const old = state[id], prevMode = old?.mode, prevColor = old?.color;
  state[id] = { fileName, svgText: text, raw: r.raw, rw: r.rw, rh: r.rh, scale, dx: 0, dy: 0, rot: 0, depth: f.depth, weight: 0,
    mode: prevMode || 'engrave', color: prevColor || INLAY_COLORS[FACES.indexOf(f)] };
  if (old) { old.raw.delete(); old._base?.cs.delete(); }
  return r;
}
async function loadFile(id, file) {
  try {
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new Error(`${file.name} isn't an SVG file.`);
    const r = setArt(id, file.name, await file.text());
    if (cutMode) setCutMode(false);
    toast(r.skipped ? `Loaded ${file.name}. Skipped ${r.skipped} outline-only path(s).` : `Loaded ${file.name} on the ${faceById(id).name.toLowerCase()}.`);
    select(id);
  } catch (e) { toast(e.message, true); }
}

// Instant part: move/scale the existing preview. Settled part (after a short pause): rebuild geometry if
// size/weight changed, re-check warnings, update the face's chip in the list.
let settleTimer = 0;
function liveUpdate(delay = 180) {
  if (cutMode) setCutMode(false);
  const f = faceById(selected);
  updateTransform(f); styleDecal(f); syncControls();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { refreshDecal(f); syncControls(); updateWarnings(); updateChip(f); }, delay);
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
  Object.assign(s, { scale: DEFAULT_SCALE, dx: 0, dy: 0, rot: 0, weight: 0, depth: f.depth });
  renderEditor(); liveUpdate(0);
};
document.querySelectorAll('.rot button').forEach(b => b.onclick = () => {
  const s = state[selected]; if (!s) return; s.rot = +b.dataset.rot; renderEditor(); scheduleRefresh();
});
$('#center').onclick = () => { const s = state[selected]; if (!s) return; s.dx = 0; s.dy = 0; renderEditor(); scheduleRefresh(); };
$('#fitBtn').onclick = () => { const s = state[selected]; if (!s) return; s.scale = 100; s.dx = 0; s.dy = 0; renderEditor(); scheduleRefresh(); };
$('#remove').onclick = () => {
  const s = state[selected]; if (!s) return; s.raw.delete(); s._base?.cs.delete(); delete state[selected];
  if (cutMode) setCutMode(false);
  refreshDecal(faceById(selected)); renderList(); renderEditor();
};
document.querySelectorAll('.mode button').forEach(b => b.onclick = () => {
  const s = state[selected]; if (!s) return; s.mode = b.dataset.mode; renderEditor(); scheduleRefresh();
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
  if (!state[selected] || cutMode || /INPUT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== 'range') return;
  if (document.activeElement?.type === 'range') return;
  const step = e.shiftKey ? 5 : 0.5, s = state[selected];
  const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (!m) return;
  e.preventDefault(); s.dx = +(s.dx + m[0]).toFixed(1); s.dy = +(s.dy + m[1]).toFixed(1); liveUpdate();
});

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast'); t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, bad ? 7000 : 3500);
}

/* ---------- Build ---------- */
const hasInlay = () => Object.values(state).some(s => s.mode === 'inlay');
const buildLabel = () => hasInlay() ? 'Download 3MF (multi-color)' : 'Download STL';

// Returns { body: Manifold, parts: [{ name, color, man }] }. Inlay parts are the pocket volumes, clipped to the box.
function buildModel() {
  const cutters = [], inlays = [];
  for (const f of FACES) {
    const s = state[f.id]; if (!s) continue;
    const p = placed(f, s);
    if (!p.cut.isEmpty()) {
      const c = p.cut.extrude(s.depth + 1).translate([0, 0, -s.depth]).transform(faceMat(f));
      cutters.push(c);
      if (s.mode === 'inlay') inlays.push({ f, s, c });
    }
    p.full.delete(); p.cut.delete();
  }
  if (!cutters.length) return null;
  const all = wasm.Manifold.union(cutters);
  const body = boxManifold.subtract(all).simplify(0.001);   // drop sub-micron slivers so the mesh stays watertight
  all.delete();
  const parts = []; let taken = null;
  for (const { f, s, c } of inlays) {
    let m = boxManifold.intersect(c);                          // only what is inside the box
    if (taken) { const t = m.subtract(taken); m.delete(); m = t; }   // no overlap where two faces meet at a corner
    const nt = taken ? taken.add(m) : m.translate([0, 0, 0]); if (taken) taken.delete(); taken = nt;
    m = m.simplify(0.001);
    if (!m.isEmpty()) parts.push({ name: `${s.fileName.replace(/\.svg$/i, '')} (${f.name})`, color: s.color, man: m });
  }
  if (taken) taken.delete();
  cutters.forEach(c => c.delete());
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
  for (let i = 0; i < v.length; i += 3) out.push(`<vertex x="${+v[i].toFixed(4)}" y="${+v[i+1].toFixed(4)}" z="${+v[i+2].toFixed(4)}"/>`);
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
  if (!Object.keys(state).length) { toast('Add at least one SVG first.', true); return; }
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

/* ---------- Boot ---------- */
(async () => {
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  wasm = await Module({ wasmBinary: b64(window.__WASM__) });
  wasm.setup();
  boxManifold = toManifold(parseSTL(b64(window.__BOX__).buffer));
  boxGeo = meshToGeo(boxManifold.getMesh());
  boxMesh = new THREE.Mesh(boxGeo, boxMat); inner.add(boxMesh);
  FACES.forEach(drawFrame); FACES.forEach(initFaceGroup);
  for (const [id, file, text] of window.__SAMPLE__) { try { setArt(id, file, text); } catch (e) { console.warn(e); } }
  FACES.forEach(refreshDecal);
  resize(); lookAtFace(null, false);
  select('left', false);
  $('#viewmode').textContent = 'Preview: drag a design to move it · Shift+scroll to resize';
  document.body.classList.remove('loading');
})().catch(e => { $('#loadingMsg').textContent = 'Could not start: ' + e.message; });
