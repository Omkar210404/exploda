// Builds every model in public/models from free sources. Run: npm run models
// Downloads are cached in scripts/.cache (git-ignored); outputs are small .glb files.
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { dedup, meshopt, normals, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';

await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const CACHE = new URL('./.cache/', import.meta.url);
const OUT = new URL('../public/models/', import.meta.url);
mkdirSync(CACHE, { recursive: true });

// usage: npm run models            (all)
//        npm run models -- brain   (comma-separated ids)
const only = process.argv[2]?.split(',');
const want = (id) => !only || only.includes(id);

async function fetchCached(url, name) {
  const file = new URL(name, CACHE);
  for (let attempt = 1; !existsSync(file); attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
  return readFileSync(file);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => { while (queue.length) await fn(queue.shift()); }));
}

const linear = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b, 1]; };

async function save(doc, id, maxTris = 30000, smooth = false, budgets = {}) {
  // per-primitive simplification: big meshes are reduced to ~maxTris, small ones keep detail
  await doc.transform(weld());
  for (const mesh of doc.getRoot().listMeshes()) {
    const limit = budgets[mesh.getName()] ?? maxTris;
    for (const prim of mesh.listPrimitives()) {
      const tris = prim.getIndices().getCount() / 3;
      if (tris > limit) simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: limit / tris, error: 0.02 });
    }
  }
  if (smooth) await doc.transform(normals({ overwrite: true }));
  await doc.transform(dedup(), prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  mkdirSync(new URL(`${id}/`, OUT), { recursive: true });
  const out = new URL(`${id}/model.glb`, OUT);
  writeFileSync(out, await io.writeBinary(doc));
  console.log(`${id}: ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}

// ---------- BodyParts3D (real anatomy, CC BY-SA 2.1 JP) ----------
const BP3D = 'https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/main/assets/BodyParts3D_data/stl/';

function parseStl(buf) {
  const n = buf.readUInt32LE(80), pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return pos;
}

function clip(pos, box) {
  // keep triangles whose centre is inside the box (trims long vessels to the organ)
  const out = [];
  for (let i = 0; i < pos.length; i += 9) {
    const x = (pos[i] + pos[i + 3] + pos[i + 6]) / 3, y = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3, z = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    if (x >= box[0] && x <= box[3] && y >= box[1] && y <= box[4] && z >= box[2] && z <= box[5]) out.push(...pos.subarray(i, i + 9));
  }
  return new Float32Array(out);
}

function bounds(pos, pad = 0) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], pos[i + k]); b[k + 3] = Math.max(b[k + 3], pos[i + k]); }
  const s = [b[3] - b[0], b[4] - b[1], b[5] - b[2]];
  return [b[0] - s[0] * pad, b[1] - s[1] * pad, b[2] - s[2] * pad, b[3] + s[0] * pad, b[4] + s[1] * pad, b[5] + s[2] * pad];
}

async function anatomy(id, { materials, meshes, clipTo, clipPad = 0.15, maxTris, budgets }) {
  const doc = new Document(), buffer = doc.createBuffer();
  const scene = doc.createScene();
  const root = doc.createNode('root').setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]); // Z-up mm -> Y-up
  scene.addChild(root);
  const clearcoat = doc.createExtension(KHRMaterialsClearcoat);
  const mats = Object.fromEntries(Object.entries(materials).map(([k, m]) => {
    const mat = doc.createMaterial(k).setBaseColorFactor(linear(m.color)).setMetallicFactor(0).setRoughnessFactor(m.rough ?? 0.5);
    if (m.coat) mat.setExtension('KHR_materials_clearcoat', clearcoat.createClearcoat().setClearcoatFactor(m.coat).setClearcoatRoughnessFactor(0.3));
    return [k, mat];
  }));
  const raw = {};
  await pool(Object.entries(meshes), 8, async ([name, [fma]]) => {
    const file = String(fma).startsWith('BP') ? fma : `FMA${fma}`;
    raw[name] = parseStl(await fetchCached(`${BP3D}${file}.stl`, `${file}.stl`));
  });
  budgets = { ...budgets, ...Object.fromEntries(Object.entries(meshes).filter(([, m]) => m[2]).map(([n, m]) => [n, m[2]])) };
  const box = clipTo ? bounds(raw[clipTo], clipPad) : null;
  for (const [name, [, matName]] of Object.entries(meshes)) {
    const pos = box ? clip(raw[name], box) : raw[name];
    if (!pos.length) throw new Error(`${id}/${name} clipped away`);
    const prim = doc.createPrimitive().setMaterial(mats[matName])
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer));
    root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  }
  await save(doc, id, maxTris, true, budgets);
}

// pick BodyParts3D meshes by English name: { group: [regex, material, maxTris] } -> nodes "group__slug"
let bp3dIndex;
async function byName(groups) {
  if (!bp3dIndex) {
    const tree = JSON.parse(await fetchCached('https://api.github.com/repos/Kevin-Mattheus-Moerman/BodyParts3D/git/trees/main?recursive=1', 'bp3d-tree.json'));
    const files = new Set(tree.tree.filter((x) => x.path.endsWith('.stl')).map((x) => x.path.split('/').pop().slice(0, -4)));
    const list = (await fetchCached('https://raw.githubusercontent.com/Kevin-Mattheus-Moerman/BodyParts3D/main/assets/BodyParts3D_data/parts_list_e.txt', 'bp3d-parts.txt')).toString('utf8');
    bp3dIndex = list.split('\n').map((l) => l.trim().split('\t')).filter(([id, n]) => n && files.has(id));
  }
  const meshes = {};
  for (const [group, [re, mat, tris]] of Object.entries(groups)) {
    const hits = bp3dIndex.filter(([, n]) => re.test(n));
    if (!hits.length) throw new Error(`no meshes for ${group}`);
    for (const [id, n] of hits) meshes[`${group}__${n.replace(/[^a-z0-9]+/gi, '_')}`] = [id.replace(/^FMA/, ''), mat, tris];
  }
  return meshes;
}

if (want('heart')) await anatomy('heart', {
  clipTo: 'heart_wall',
  maxTris: 12000,
  budgets: { heart_wall: 60000 },
  materials: {
    myocardium: { color: 0x8c2a2c, rough: 0.45, coat: 0.5 }, artery: { color: 0xb3282c, rough: 0.4, coat: 0.6 },
    vein: { color: 0x3d4f8f, rough: 0.4, coat: 0.6 }, valve: { color: 0xe4cfae, rough: 0.55, coat: 0.3 },
    papillary: { color: 0xa0413f, rough: 0.5, coat: 0.4 },
  },
  meshes: {
    heart_wall: [7274, 'myocardium'], tricuspid_valve: [7234, 'valve'], mitral_valve: [7235, 'valve'], pulmonary_valve: [7246, 'valve'],
    ascending_aorta: [3736, 'artery'], arch_of_aorta: [3768, 'artery'], descending_aorta: [3784, 'artery'],
    pulmonary_artery: [66326, 'vein'], pulmonary_veins: [66643, 'artery'],
    superior_vena_cava: [4720, 'vein'], inferior_vena_cava: [10951, 'vein'], coronary_sinus: [4706, 'vein'],
    rca_trunk: [3802, 'artery'], rca_marginal: [3818, 'artery'], rca_posterior: ['3840nsn', 'artery'], rca_posterolateral: [76994, 'artery'],
    lca_stem: [4685, 'artery'], lca_anterior: ['3862nsn', 'artery'], lca_circumflex: [3895, 'artery'],
    great_cardiac_vein: [4707, 'vein'], middle_cardiac_vein: [4713, 'vein'], anterior_cardiac_veins: [71567, 'vein'], posterior_lv_veins: [76751, 'vein'],
    papillary_rv_anterior: [7260, 'papillary'], papillary_rv_posterior: [7261, 'papillary'], papillary_rv_septal: [7262, 'papillary'],
    papillary_lv_posterior: [7266, 'papillary'], papillary_lv: ['9352nsn', 'papillary'],
  },
});

const bone = { color: 0xe6dcc6, rough: 0.6, coat: 0.1 };
if (want('skull')) await anatomy('skull', {
  maxTris: 16000,
  materials: { bone, jaw: { ...bone, color: 0xe0d3b8 }, face: { ...bone, color: 0xe9e0cc } },
  meshes: {
    frontal_bone: [52734, 'bone'], parietal_right: [52788, 'bone'], parietal_left: [52789, 'bone'], temporal_right: [52738, 'bone'], temporal_left: [52739, 'bone'],
    occipital_bone: [52735, 'bone'], sphenoid_bone: [52736, 'bone'], ethmoid_bone: [52740, 'face'], zygomatic_right: [52892, 'face'], zygomatic_left: [52893, 'face'],
    maxilla_right: [53649, 'face'], maxilla_left: [53650, 'face'], nasal_right: [53647, 'face'], nasal_left: [53648, 'face'], lacrimal_right: [53645, 'face'],
    lacrimal_left: [53646, 'face'], palatine_right: [53655, 'face'], palatine_left: [53656, 'face'], vomer: [9710, 'face'], mandible: [52748, 'jaw'], hyoid_bone: [52749, 'jaw'],
  },
});

if (want('lungs')) await anatomy('lungs', {
  maxTris: 30000,
  materials: { lung: { color: 0xd98f8a, rough: 0.55, coat: 0.35 }, lung2: { color: 0xcf8580, rough: 0.55, coat: 0.35 }, airway: { color: 0xe8d2c2, rough: 0.5, coat: 0.3 } },
  meshes: {
    right_upper_lobe: [7333, 'lung'], right_middle_lobe: [7383, 'lung2'], right_lower_lobe: [7337, 'lung'],
    left_upper_lobe: [7370, 'lung2'], left_lower_lobe: [7371, 'lung'], trachea: [7394, 'airway'], bronchi: [7409, 'airway'],
  },
});

if (want('brain')) await anatomy('brain', {
  maxTris: 3000,
  materials: {
    cortex: { color: 0xd9a7a0, rough: 0.6, coat: 0.25 }, cortex2: { color: 0xcf9a93, rough: 0.6, coat: 0.25 },
    deep: { color: 0xb98a7c, rough: 0.55, coat: 0.2 }, white: { color: 0xeee6dc, rough: 0.55, coat: 0.2 },
    stem: { color: 0xc99486, rough: 0.55, coat: 0.25 }, gland: { color: 0xc77f6f, rough: 0.5, coat: 0.3 },
  },
  meshes: await byName({
    frontal_lobe: [/^(left|right) (superior frontal|middle frontal|precentral) gyrus$|^orbital gyri/, 'cortex'],
    parietal_lobe: [/^(left|right) (postcentral|supramarginal|angular) gyrus$/, 'cortex2'],
    temporal_lobe: [/superior temporal gyrus$|^(left|right) (middle temporal|inferior temporal|fusiform) gyrus$/, 'cortex2'],
    occipital_lobe: [/^(left|right) occipital lobe$/, 'cortex'],
    insula: [/^(left|right) (insula|accessory short gyrus)$/, 'cortex'],
    limbic_system: [/^(left|right) (cingulate gyrus|parahippocampal gyrus|hippocampus|amygdala|fornix of forebrain)$|^commissure of fornix/, 'deep'],
    corpus_callosum: [/^corpus callosum$/, 'white', 6000],
    thalamus: [/^(left|right) (thalamus|stria medullaris of thalamus)$/, 'deep'],
    basal_ganglia: [/^(left|right) (caudate nucleus|putamen)$/, 'deep'],
    hypothalamus: [/^hypothalamus/, 'gland'],
    pituitary_gland: [/^pituitary gland$/, 'gland'],
    optic_chiasm: [/^optic chiasm$/, 'white'],
    brainstem: [/^(midbrain|peduncle of midbrain|pons|medulla oblongata)/, 'stem', 5000],
    cerebellum: [/^cerebellum$/, 'stem', 16000],
  }),
});

if (want('abdomen')) await anatomy('abdomen', {
  maxTris: 12000,
  materials: {
    liver: { color: 0x7a2e26, rough: 0.45, coat: 0.5 }, organ: { color: 0xb5564a, rough: 0.5, coat: 0.45 }, gut: { color: 0xd99a86, rough: 0.5, coat: 0.45 },
    kidney: { color: 0x8e3a32, rough: 0.45, coat: 0.5 }, green: { color: 0x5f7a3a, rough: 0.45, coat: 0.5 }, gland: { color: 0xd2a35a, rough: 0.5, coat: 0.4 },
    pale: { color: 0xe3c6a8, rough: 0.5, coat: 0.4 },
  },
  meshes: await byName({
    liver: [/^liver$/, 'liver', 20000], stomach: [/^stomach$/, 'organ'], spleen: [/^spleen$/, 'kidney'],
    pancreas: [/^pancreas/, 'gland'], gallbladder: [/^gallbladder$/, 'green'], kidneys: [/^(left|right) kidney$/, 'kidney'],
    adrenal_glands: [/^(left|right) adrenal gland$/, 'gland'], ureters: [/^(left|right) ureter$/, 'pale'], urinary_bladder: [/^urinary bladder$/, 'pale'],
    esophagus: [/^esophagus$/, 'organ'], duodenum: [/^duodenum$/, 'gut'], small_intestine: [/^(jejunum|ileum)$/, 'gut', 16000],
    large_intestine: [/^(colon|appendix|rectum)/, 'gut', 16000],
  }),
});

if (want('skeleton')) {
  const side = '^(left|right) ';
  await anatomy('skeleton', {
    maxTris: 900,
    materials: { bone: { color: 0xe6dcc6, rough: 0.6, coat: 0.1 }, disc: { color: 0x9fb6c9, rough: 0.5, coat: 0.2 } },
    meshes: await byName({
      skull: [/^(frontal bone|occipital bone|sphenoid bone|ethmoid|vomer|mandible|hyoid bone)$|^(left|right) (parietal bone|temporal bone|zygomatic bone|maxilla|nasal bone|lacrimal bone|palatine bone)$/, 'bone', 1800],
      cervical_spine: [/^[a-z]+ cervical vertebra$|^(atlas|axis)$/, 'bone'],
      thoracic_spine: [/^[a-z]+ thoracic vertebra$/, 'bone'],
      lumbar_spine: [/^[a-z]+ lumbar vertebra$/, 'bone'],
      intervertebral_discs: [/^intervertebral disk of/, 'disc', 300],
      sacrum: [/^sacrum$/, 'bone', 3000],
      ribs: [new RegExp(`${side}\\w+ rib$`), 'bone'],
      sternum: [/^(body of sternum|manubrium|xiphoid process)$/, 'bone'],
      clavicles: [new RegExp(`${side}clavicle$`), 'bone'],
      scapulae: [new RegExp(`${side}scapula$`), 'bone', 2500],
      humerus: [new RegExp(`${side}humerus$`), 'bone', 2500],
      forearm: [new RegExp(`${side}(radius|ulna)$`), 'bone', 2000],
      hands: [/^(left|right) (scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate)$|metacarpal bone$|phalanx of (left|right) (thumb|\w+ finger)$/, 'bone', 250],
      pelvis: [new RegExp(`${side}hip bone$`), 'bone', 4000],
      femur: [new RegExp(`${side}femur$`), 'bone', 3000],
      patella: [new RegExp(`${side}patella$`), 'bone'],
      lower_leg: [new RegExp(`${side}(tibia|fibula)$`), 'bone', 2500],
      feet: [/^(left|right) (talus|calcaneus|cuboid bone|\w+ cuneiform bone)$|^navicular bone of|metatarsal bone$|phalanx of (left|right) \w+ toe$|^sesamoid bone of/, 'bone', 250],
    }),
  });
}

// ---------- Solar system: textured spheres (textures: Solar System Scope, CC BY 4.0) ----------
if (want('solar-system')) {
  const TEX = 'https://www.solarsystemscope.com/textures/download/';
  const bodies = [
    ['sun', 2.2, 0, '2k_sun.jpg'], ['mercury', 0.2, 3.4, '2k_mercury.jpg'], ['venus', 0.34, 4.3, '2k_venus_atmosphere.jpg'],
    ['earth', 0.36, 5.3, '2k_earth_daymap.jpg'], ['moon', 0.1, 5.85, '2k_moon.jpg'], ['mars', 0.27, 6.4, '2k_mars.jpg'],
    ['jupiter', 0.95, 8.2, '2k_jupiter.jpg'], ['saturn', 0.8, 10.6, '2k_saturn.jpg'], ['uranus', 0.55, 12.6, '2k_uranus.jpg'], ['neptune', 0.53, 14.2, '2k_neptune.jpg'],
  ];
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  const texture = async (file, mime = 'image/jpeg') => doc.createTexture(file).setImage(await fetchCached(TEX + file, file)).setMimeType(mime);
  const addGeo = (name, geo, mat, pos) => {
    const prim = doc.createPrimitive().setMaterial(mat).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(geo.index.array)).setBuffer(buffer));
    for (const [attr, key, type] of [['position', 'POSITION', 'VEC3'], ['normal', 'NORMAL', 'VEC3'], ['uv', 'TEXCOORD_0', 'VEC2']]) {
      prim.setAttribute(key, doc.createAccessor().setType(type).setArray(new Float32Array(geo.attributes[attr].array)).setBuffer(buffer));
    }
    return doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)).setTranslation(pos);
  };
  for (const [i, [name, r, d, file]] of bodies.entries()) {
    const a = name === 'moon' ? -0.5 + 3 * 0.12 + 0.12 : -0.5 + i * 0.12;
    const pos = [d * Math.cos(a), 0, d * Math.sin(a)];
    const tex = await texture(file);
    const mat = doc.createMaterial(name).setRoughnessFactor(0.9).setMetallicFactor(0);
    if (name === 'sun') mat.setEmissiveTexture(tex).setEmissiveFactor([1, 1, 1]).setBaseColorFactor([0, 0, 0, 1]);
    else mat.setBaseColorTexture(tex);
    const node = addGeo(name, new THREE.SphereGeometry(r, 64, 48), mat, pos);
    if (name === 'saturn') {
      // ring with radial UVs so the ring texture runs from inner to outer edge
      const ring = new THREE.RingGeometry(r * 1.24, r * 2.27, 128, 1);
      const p = ring.attributes.position, uv = ring.attributes.uv;
      for (let k = 0; k < p.count; k++) uv.setXY(k, (Math.hypot(p.getX(k), p.getY(k)) - r * 1.24) / (r * 1.03), 0.5);
      ring.rotateX(-Math.PI / 2);
      const ringMat = doc.createMaterial('saturn_ring').setBaseColorTexture(await texture('2k_saturn_ring_alpha.png', 'image/png'))
        .setAlphaMode('BLEND').setDoubleSided(true).setRoughnessFactor(0.9).setMetallicFactor(0);
      node.addChild(addGeo('saturn_ring', ring, ringMat, [0, 0, 0]).setRotation(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.45, 0, 0.1)).toArray()));
    }
    scene.addChild(node);
  }
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }));
  await save(doc, 'solar-system', 100000);
}

// ---------- Khronos sample assets (realistic PBR models) ----------
async function khronos(id, name, size = 1024) {
  const url = `https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/${name}/glTF-Binary/${name}.glb`;
  const doc = await io.readBinary(new Uint8Array(await fetchCached(url, `${name}.glb`)));
  await doc.transform(textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 82 }));
  await save(doc, id, 200000);
}
if (want('concept-car')) await khronos('concept-car', 'CarConcept');
if (want('chronograph-watch')) await khronos('chronograph-watch', 'ChronographWatch');
