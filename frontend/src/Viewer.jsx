import { Component, Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Billboard, Bounds, ContactShadows, Environment, Html, OrbitControls, Stars, useGLTF, useProgress } from '@react-three/drei';
import * as THREE from 'three';

const GOLD = new THREE.Color('#f2b84b');
const BLUE = new THREE.Color('#6fb4ff');
const SPREAD = 0.6;
const noRaycast = () => null;
const HDRI = `${import.meta.env.BASE_URL}hdri/studio.hdr`;

// parts.json: a part covers its own mesh name, or the names/globs in "meshes" (e.g. "BodyDoorL*")
function compileRules(parts) {
  return Object.entries(parts).flatMap(([id, p]) => (p.meshes ?? [id]).map((pat) => {
    const clean = THREE.PropertyBinding.sanitizeNodeName(pat).replace(/[-[\]{}()+?,\\^$|#]/g, '\\$&');
    return { id, len: pat.length, re: new RegExp(`^${clean.replace(/\*/g, '.*')}$`) };
  }));
}

// nearest named ancestor that matches a rule; the most specific pattern wins
function partOf(obj, rules) {
  for (let o = obj; o; o = o.parent) {
    const hits = rules.filter((r) => r.re.test(o.name));
    if (hits.length) return hits.sort((a, b) => b.len - a.len)[0].id;
  }
  return null;
}

function Model({ url, parts, hovered, selected, onHover, onSelect, onMoreInfo, explode, hotspots, xray, stage, tooltip }) {
  const { scene } = useGLTF(url);

  const { root, groups, floor } = useMemo(() => {
    const root = scene.clone(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3()), s = 4 / Math.max(size.x, size.y, size.z);
    root.scale.multiplyScalar(s);
    root.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(s));
    root.updateMatrixWorld(true);

    const rules = compileRules(parts), groups = {};
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.castShadow = o.receiveShadow = true;
      const m = o.material;
      o.userData.base = { emissive: m.emissive?.clone(), ei: m.emissiveIntensity, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite };
      o.userData.basePos = o.position.clone();
      o.userData.part = partOf(o, rules);
      if (o.userData.part) (groups[o.userData.part] ??= { meshes: [], box: new THREE.Box3() }).meshes.push(o);
    });
    for (const g of Object.values(groups)) {
      g.meshes.forEach((o) => g.box.expandByObject(o));
      g.center = g.box.getCenter(new THREE.Vector3());
      g.dir = g.center.lengthSq() > 0.02 ? g.center.clone() : new THREE.Vector3();
      for (const o of g.meshes) {
        // explode direction in the mesh's parent space, so nested/scaled nodes move correctly
        const inv = o.parent.matrixWorld.clone().invert();
        o.userData.dirLocal = g.center.clone().add(g.dir).applyMatrix4(inv).sub(g.center.clone().applyMatrix4(inv));
      }
    }
    return { root, groups, floor: -size.y * s / 2 };
  }, [scene, parts]);

  useEffect(() => {
    for (const [id, g] of Object.entries(groups)) {
      const shell = xray && parts[id]?.shell && id !== selected;
      for (const o of g.meshes) {
        const m = o.material, b = o.userData.base;
        if (m.emissive) {
          if (id === selected) { m.emissive.copy(GOLD); m.emissiveIntensity = 0.3; }
          else if (id === hovered) { m.emissive.copy(BLUE); m.emissiveIntensity = 0.22; }
          else { m.emissive.copy(b.emissive); m.emissiveIntensity = b.ei; }
        }
        m.transparent = shell || b.transparent;
        m.opacity = shell ? 0.12 : b.opacity;
        m.depthWrite = shell ? false : b.depthWrite;
        m.needsUpdate = true;
        o.raycast = shell ? noRaycast : THREE.Mesh.prototype.raycast; // click through see-through shells
      }
    }
  }, [groups, parts, hovered, selected, xray]);

  const amount = useRef(0), markers = useRef({});
  useFrame((_, dt) => {
    amount.current += (explode - amount.current) * Math.min(1, dt * 8);
    const k = amount.current * SPREAD;
    for (const [id, g] of Object.entries(groups)) {
      for (const o of g.meshes) o.position.copy(o.userData.basePos).addScaledVector(o.userData.dirLocal, k);
      markers.current[id]?.position.copy(g.center).addScaledVector(g.dir, k);
    }
  });

  const moveTip = (e, name) => {
    const el = tooltip.current;
    if (!el) return;
    el.textContent = name;
    el.style.opacity = name ? 1 : 0;
    el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  };

  return (
    <>
      <Bounds fit clip observe margin={stage === 'space' ? 1.05 : 1.15}>
      <primitive
        object={root}
        onPointerMove={(e) => {
          e.stopPropagation();
          const id = e.object.userData.part;
          if (id !== hovered) onHover(id);
          moveTip(e, id ? parts[id].name : '');
          document.body.style.cursor = id ? 'pointer' : 'auto';
        }}
        onPointerOut={(e) => { onHover(null); moveTip(e, ''); document.body.style.cursor = 'auto'; }}
        onClick={(e) => {
          e.stopPropagation();
          if (e.object.userData.part) onSelect(e.object.userData.part);
        }}
      />
      {Object.entries(groups).map(([id, g]) => (
        <group key={id} ref={(el) => { markers.current[id] = el; }} position={g.center}>
          {hotspots && id !== selected && (
            <Billboard>
              <mesh raycast={noRaycast} renderOrder={10}>
                <ringGeometry args={[0.03, 0.045, 24]} />
                <meshBasicMaterial color="#f2c46d" transparent opacity={0.5} depthTest={false} />
              </mesh>
              <mesh raycast={noRaycast} renderOrder={10}>
                <circleGeometry args={[0.014, 16]} />
                <meshBasicMaterial color="#ffe2a6" transparent opacity={0.75} depthTest={false} />
              </mesh>
            </Billboard>
          )}
          {id === selected && (
            <Html center zIndexRange={[20, 10]}>
              <div className="part-label glass">
                <span className="dot" />
                <strong>{parts[id].name}</strong>
                <button onClick={(e) => { e.stopPropagation(); onMoreInfo(); }}>More info</button>
              </div>
            </Html>
          )}
        </group>
      ))}
      </Bounds>
      {stage === 'space' && groups.sun && <pointLight position={groups.sun.center} intensity={4} decay={0} />}
      {stage !== 'space' && <ContactShadows position={[0, floor - 0.02, 0]} opacity={0.5} scale={10} blur={2.4} far={3} />}
    </>
  );
}

function Loader() {
  const { progress } = useProgress();
  return <Html center><div className="state"><span className="spinner" /> Loading model… {progress.toFixed(0)}%</div></Html>;
}

class ModelError extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed
      ? <Html center><div className="state error">Could not load this model file.</div></Html>
      : this.props.children;
  }
}

export default function Viewer(props) {
  const tooltip = useRef(null);
  const space = props.stage === 'space';
  return (
    <div className={`viewer ${space ? 'space' : ''}`}>
      <Canvas shadows dpr={[1, 2]} camera={{ position: [2.6, 1.6, 6.4], fov: 40 }} onPointerMissed={() => props.onSelect(null)}>
        {space ? (
          <>
            <ambientLight intensity={0.06} />
            <Stars radius={80} depth={40} count={4000} factor={3} saturation={0} fade />
          </>
        ) : (
          <>
            <ambientLight intensity={0.15} />
            <directionalLight position={[4, 6, 5]} intensity={1.2} castShadow shadow-mapSize={[1024, 1024]} />
          </>
        )}
        <ModelError>
          <Suspense fallback={<Loader />}>
            {!space && <Environment files={HDRI} environmentIntensity={0.9} />}
            <Model {...props} tooltip={tooltip} />
          </Suspense>
        </ModelError>
        <OrbitControls makeDefault enableDamping minDistance={1} maxDistance={20} />
      </Canvas>
      <div ref={tooltip} className="tooltip" />
    </div>
  );
}
