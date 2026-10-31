// Builds the simplified multi-part models as .glb files (one named mesh per part).
// Run: npm run models
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { writeFileSync } from 'node:fs';

const OUT = new URL('../public/models/', import.meta.url);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------- geometry helpers ----------
function place(geo, { pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
  const m = new THREE.Matrix4().compose(
    V(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)),
    V(...scale),
  );
  return geo.applyMatrix4(m);
}
const sphere = (r, o) => place(new THREE.SphereGeometry(r, 40, 28), o);
const cyl = (rt, rb, h, o, seg = 32) => place(new THREE.CylinderGeometry(rt, rb, h, seg), o);
const box = (w, h, d, o) => place(new THREE.BoxGeometry(w, h, d), o);
const torus = (r, t, o) => place(new THREE.TorusGeometry(r, t, 20, 64), o);
const tube = (pts, r) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => V(...p))), 64, r, 20, false);
const merge = (...geos) => mergeGeometries(geos.map((g) => { g = g.index ? g.toNonIndexed() : g; g.deleteAttribute('uv'); return g; }));

// ---------- GLB writer ----------
function writeGLB(name, parts) {
  // normalise the whole model to ~4 units and centre it
  const box3 = new THREE.Box3();
  parts.forEach((p) => { p.geo.computeBoundingBox(); box3.union(p.geo.boundingBox); });
  const size = box3.getSize(V()), center = box3.getCenter(V());
  const s = 4 / Math.max(size.x, size.y, size.z);
  const norm = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

  const bin = [], json = { asset: { version: '2.0', generator: 'exploda build-models' }, scene: 0,
    scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  let offset = 0;
  const view = (arr, target) => {
    const bytes = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bin.push(bytes, Buffer.alloc(pad));
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    offset += bytes.length + pad;
    return json.bufferViews.length - 1;
  };

  parts.forEach((p, i) => {
    let g = p.geo.applyMatrix4(norm);
    const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
    const count = g.attributes.position.count;
    const src = g.index ? g.index.array : [...Array(count).keys()];
    const idx = count > 65535 ? new Uint32Array(src) : new Uint16Array(src);
    g.computeBoundingBox();
    const { min, max } = g.boundingBox;
    json.accessors.push(
      { bufferView: view(new Float32Array(pos), 34962), componentType: 5126, count, type: 'VEC3', min: min.toArray(), max: max.toArray() },
      { bufferView: view(new Float32Array(nrm), 34962), componentType: 5126, count, type: 'VEC3' },
      { bufferView: view(idx, 34963), componentType: count > 65535 ? 5125 : 5123, count: idx.length, type: 'SCALAR' },
    );
    const c = new THREE.Color(p.color); // stored linear, as glTF expects
    const e = new THREE.Color(p.emissive ?? 0x000000);
    json.materials.push({ name: p.id, pbrMetallicRoughness: { baseColorFactor: [c.r, c.g, c.b, 1],
      metallicFactor: p.metal ?? 0.05, roughnessFactor: p.rough ?? 0.5 }, emissiveFactor: [e.r, e.g, e.b], doubleSided: !!p.double });
    json.meshes.push({ name: p.id, primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    json.nodes.push({ name: p.id, mesh: i });
    json.scenes[0].nodes.push(i);
  });

  const binBuf = Buffer.concat(bin);
  json.buffers.push({ byteLength: binBuf.length });
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binBuf.length, 8);
  const chunk = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  const glb = Buffer.concat([header, chunk(jsonBuf.length, 0x4e4f534a), jsonBuf, chunk(binBuf.length, 0x004e4942), binBuf]);
  writeFileSync(new URL(`${name}/model.glb`, OUT), glb);
  console.log(`${name}: ${parts.length} parts, ${(glb.length / 1024).toFixed(0)} KB`);
}

// ---------- Human heart (anterior view, simplified) ----------
const blueVessel = 0x3f5f9f, redVessel = 0xc2413f;
writeGLB('heart', [
  { id: 'right_atrium', color: 0xa33a44, geo: sphere(0.9, { pos: [-1.05, 1.05, 0.15], scale: [1, 0.95, 0.9] }) },
  { id: 'left_atrium', color: 0xa8424a, geo: sphere(0.82, { pos: [0.95, 1.2, -0.55], scale: [1.1, 0.85, 0.9] }) },
  { id: 'right_ventricle', color: 0x8f2430, geo: sphere(1.25, { pos: [-0.55, -0.45, 0.45], rot: [0, 0, 0.25], scale: [1, 1.2, 0.8] }) },
  { id: 'left_ventricle', color: 0x9c2a35, geo: sphere(1.3, { pos: [0.55, -0.7, -0.15], rot: [0, 0, 0.4], scale: [1, 1.45, 1] }) },
  { id: 'aorta', color: redVessel, geo: tube([[0.15, 0.8, 0], [0.1, 2.2, 0.1], [0.5, 3.0, -0.1], [1.3, 2.9, -0.5], [1.65, 1.8, -0.9], [1.7, 0.2, -1.0]], 0.32) },
  { id: 'pulmonary_trunk', color: blueVessel, geo: merge(
    tube([[-0.3, 0.8, 0.75], [-0.15, 1.8, 0.85], [0.3, 2.35, 0.55]], 0.28),
    tube([[0.3, 2.35, 0.55], [1.0, 2.4, 0.3], [1.9, 2.3, 0.1]], 0.16),
    tube([[0.3, 2.35, 0.55], [-0.6, 2.5, 0.4], [-1.9, 2.4, 0.1]], 0.16)) },
  { id: 'superior_vena_cava', color: blueVessel, geo: tube([[-1.2, 1.5, 0.05], [-1.25, 2.4, 0], [-1.2, 3.3, -0.1]], 0.26) },
  { id: 'inferior_vena_cava', color: blueVessel, geo: tube([[-1.1, 0.4, -0.15], [-1.15, -0.6, -0.4], [-1.2, -1.7, -0.5]], 0.26) },
  { id: 'pulmonary_veins', color: 0xb8484a, geo: merge(
    tube([[1.3, 1.45, -0.6], [1.9, 1.6, -0.55], [2.5, 1.7, -0.5]], 0.11),
    tube([[1.35, 1.0, -0.6], [1.95, 0.95, -0.6], [2.5, 0.9, -0.55]], 0.11),
    tube([[0.55, 1.45, -0.9], [0.1, 1.6, -1.2], [-0.5, 1.7, -1.4]], 0.11),
    tube([[0.55, 1.0, -0.95], [0.1, 0.95, -1.25], [-0.5, 0.9, -1.45]], 0.11)) },
  { id: 'tricuspid_valve', color: 0xe8d3a6, rough: 0.35, geo: torus(0.42, 0.09, { pos: [-0.85, 0.35, 0.6], rot: [1.2, 0, 0.3] }) },
  { id: 'mitral_valve', color: 0xe8d3a6, rough: 0.35, geo: torus(0.4, 0.09, { pos: [0.85, 0.45, -0.35], rot: [1.3, 0, -0.4] }) },
  { id: 'aortic_valve', color: 0xf0dcb0, rough: 0.35, geo: torus(0.36, 0.08, { pos: [0.15, 0.85, 0], rot: [Math.PI / 2, 0, 0] }) },
  { id: 'pulmonary_valve', color: 0xf0dcb0, rough: 0.35, geo: torus(0.32, 0.075, { pos: [-0.3, 0.85, 0.75], rot: [Math.PI / 2, 0, 0] }) },
  { id: 'coronary_arteries', color: 0xe36a5c, geo: merge(
    tube([[0.15, 0.75, 0.6], [0.05, 0.1, 1.05], [0.15, -0.9, 0.95], [0.35, -1.9, 0.45]], 0.06),
    tube([[-0.1, 0.75, 0.55], [-0.9, 0.3, 0.95], [-1.45, -0.4, 0.55], [-1.3, -1.2, 0.1]], 0.06)) },
]);

// ---------- Inline-4 engine (cutaway: block and head sit behind the moving parts) ----------
const xs = [-1.8, -0.6, 0.6, 1.8], up = [true, false, false, true];
const steel = 0x9aa3ad;
writeGLB('engine', [
  { id: 'cylinder_block', color: 0x5f6873, metal: 0.6, rough: 0.55, geo: box(4.8, 2.6, 0.9, { pos: [0, -0.1, -1.0] }) },
  { id: 'cylinder_head', color: 0x737d88, metal: 0.6, rough: 0.5, geo: box(4.8, 0.8, 1.6, { pos: [0, 1.75, -0.75] }) },
  { id: 'pistons', color: 0xc9ced4, metal: 0.85, rough: 0.3, geo: merge(...xs.map((x, i) => cyl(0.42, 0.42, 0.55, { pos: [x, up[i] ? 0.85 : 0.35, 0] }))) },
  { id: 'connecting_rods', color: steel, metal: 0.85, rough: 0.35, geo: merge(...xs.map((x, i) => {
    const top = up[i] ? 0.7 : 0.2, bot = up[i] ? -1.0 : -1.6;
    return box(0.16, top - bot, 0.12, { pos: [x, (top + bot) / 2, 0.05] });
  })) },
  { id: 'crankshaft', color: 0x8a939e, metal: 0.9, rough: 0.3, geo: merge(
    cyl(0.17, 0.17, 5.0, { pos: [0, -1.3, 0], rot: [0, 0, Math.PI / 2] }),
    ...xs.flatMap((x, i) => [box(0.12, 0.75, 0.5, { pos: [x - 0.18, up[i] ? -1.05 : -1.55, 0] }), box(0.12, 0.75, 0.5, { pos: [x + 0.18, up[i] ? -1.05 : -1.55, 0] })])) },
  { id: 'camshaft', color: 0xa7afb8, metal: 0.9, rough: 0.3, geo: merge(
    cyl(0.1, 0.1, 5.0, { pos: [0, 2.45, 0.1], rot: [0, 0, Math.PI / 2] }),
    ...xs.flatMap((x) => [-0.2, 0.2].map((dx) => cyl(0.17, 0.17, 0.1, { pos: [x + dx, 2.4, 0.1], rot: [0, 0, Math.PI / 2], scale: [1, 1, 1.4] })))) },
  { id: 'intake_valves', color: 0xb9c2cb, metal: 0.9, rough: 0.25, geo: merge(...xs.flatMap((x) => [
    cyl(0.03, 0.03, 0.9, { pos: [x - 0.2, 1.65, 0.1] }), cyl(0.15, 0.15, 0.04, { pos: [x - 0.2, 1.2, 0.1] })])) },
  { id: 'exhaust_valves', color: 0xc08a5a, metal: 0.8, rough: 0.35, geo: merge(...xs.flatMap((x) => [
    cyl(0.03, 0.03, 0.9, { pos: [x + 0.2, 1.65, 0.1] }), cyl(0.14, 0.14, 0.04, { pos: [x + 0.2, 1.2, 0.1] })])) },
  { id: 'spark_plugs', color: 0xe9e6df, rough: 0.4, geo: merge(...xs.flatMap((x) => [
    cyl(0.07, 0.07, 0.5, { pos: [x, 1.55, 0.35] }), cyl(0.1, 0.1, 0.18, { pos: [x, 1.9, 0.35] }, 6)])) },
  { id: 'flywheel', color: 0x6b737c, metal: 0.85, rough: 0.4, geo: cyl(1.1, 1.1, 0.18, { pos: [-2.75, -1.3, 0], rot: [0, 0, Math.PI / 2] }, 64) },
  { id: 'timing_belt', color: 0x2a2d31, rough: 0.8, geo: merge(
    torus(0.3, 0.05, { pos: [2.65, -1.3, 0], rot: [0, Math.PI / 2, 0] }), torus(0.3, 0.05, { pos: [2.65, 2.45, 0.1], rot: [0, Math.PI / 2, 0] }),
    box(0.06, 3.75, 0.1, { pos: [2.65, 0.575, 0.3] }), box(0.06, 3.75, 0.1, { pos: [2.65, 0.575, -0.27] })) },
  { id: 'oil_pan', color: 0x4b525a, metal: 0.5, rough: 0.6, geo: box(4.6, 0.55, 1.7, { pos: [0, -2.35, -0.3] }) },
]);

// ---------- Solar system (sizes and distances not to scale) ----------
const planets = [
  ['mercury', 0.18, 2.7, 0x9c958c], ['venus', 0.3, 3.5, 0xd9b77a], ['earth', 0.32, 4.4, 0x3f7fcf], ['mars', 0.24, 5.2, 0xc1593a],
  ['jupiter', 0.78, 6.6, 0xc9a27e], ['saturn', 0.64, 8.4, 0xdcc48f], ['uranus', 0.46, 9.9, 0x8fd2d8], ['neptune', 0.45, 11.1, 0x4a6fd8],
];
writeGLB('solar-system', [
  { id: 'sun', color: 0xffb547, emissive: 0xff9a2e, rough: 1, geo: sphere(1.7, {}) },
  ...planets.map(([id, r, d, color], i) => {
    const a = -0.5 + i * 0.13, pos = [d * Math.cos(a), 0, d * Math.sin(a)];
    const geo = id === 'saturn'
      ? merge(sphere(r, { pos }), place(new THREE.RingGeometry(r * 1.35, r * 2.2, 64), { pos, rot: [-Math.PI / 2 + 0.45, 0, 0] }))
      : sphere(r, { pos });
    return { id, color, rough: 0.7, double: id === 'saturn', geo };
  }),
]);
