import { Component, Suspense, useEffect, useMemo, useRef } from 'react';
import { Canvas, createPortal, useFrame } from '@react-three/fiber';
import { Billboard, Bounds, ContactShadows, Environment, Html, Lightformer, OrbitControls, useGLTF, useProgress } from '@react-three/drei';
import * as THREE from 'three';

const GOLD = new THREE.Color('#f2b84b');
const BLUE = new THREE.Color('#6fb4ff');
const noRaycast = () => null;

function Model({ url, parts, hovered, selected, onHover, onSelect, onMoreInfo, explode, hotspots, tooltip }) {
  const { scene } = useGLTF(url);
  const root = useMemo(() => scene.clone(true), [scene]);

  // one material per mesh so highlighting one part never touches another
  const meshes = useMemo(() => {
    const list = [];
    const all = new THREE.Box3().setFromObject(root);
    const mid = all.getCenter(new THREE.Vector3());
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = o.material.clone();
      o.castShadow = o.receiveShadow = true;
      o.geometry.computeBoundingBox();
      const center = o.geometry.boundingBox.getCenter(new THREE.Vector3());
      const dir = center.clone().sub(mid);
      if (dir.lengthSq() < 0.01) dir.set(0, 0, 0);
      o.userData = { center, dir, base: o.material.emissive.clone(), baseI: o.material.emissiveIntensity };
      list.push(o);
    });
    return list;
  }, [root]);

  useEffect(() => {
    for (const m of meshes) {
      const mat = m.material;
      if (m.name === selected) { mat.emissive.copy(GOLD); mat.emissiveIntensity = 0.3; }
      else if (m.name === hovered) { mat.emissive.copy(BLUE); mat.emissiveIntensity = 0.22; }
      else { mat.emissive.copy(m.userData.base); mat.emissiveIntensity = m.userData.baseI; }
    }
  }, [meshes, hovered, selected]);

  useFrame((_, dt) => {
    for (const m of meshes) {
      const target = m.userData.dir.clone().multiplyScalar(explode * 0.6);
      m.position.lerp(target, Math.min(1, dt * 8));
    }
  });

  const moveTip = (e, name) => {
    const el = tooltip.current;
    if (!el) return;
    el.textContent = name;
    el.style.opacity = name ? 1 : 0;
    el.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
  };

  const sel = meshes.find((m) => m.name === selected);

  return (
    <>
      <primitive
        object={root}
        onPointerMove={(e) => {
          e.stopPropagation();
          const id = parts[e.object.name] ? e.object.name : null;
          if (id !== hovered) onHover(id);
          moveTip(e, id ? parts[id].name : '');
          document.body.style.cursor = id ? 'pointer' : 'auto';
        }}
        onPointerOut={(e) => { onHover(null); moveTip(e, ''); document.body.style.cursor = 'auto'; }}
        onClick={(e) => {
          e.stopPropagation();
          if (parts[e.object.name]) onSelect(e.object.name);
        }}
      />
      {hotspots && meshes.filter((m) => parts[m.name] && m.name !== selected).map((m) => createPortal(
        <Billboard position={m.userData.center}>
          <mesh raycast={noRaycast} renderOrder={10}>
            <ringGeometry args={[0.03, 0.045, 24]} />
            <meshBasicMaterial color="#f2c46d" transparent opacity={0.5} depthTest={false} />
          </mesh>
          <mesh raycast={noRaycast} renderOrder={10}>
            <circleGeometry args={[0.014, 16]} />
            <meshBasicMaterial color="#ffe2a6" transparent opacity={0.75} depthTest={false} />
          </mesh>
        </Billboard>,
        m, { key: m.name },
      ))}
      {sel && createPortal(
        <Html position={sel.userData.center} center zIndexRange={[20, 10]}>
          <div className="part-label glass">
            <span className="dot" />
            <strong>{parts[selected].name}</strong>
            <button onClick={(e) => { e.stopPropagation(); onMoreInfo(); }}>More info</button>
          </div>
        </Html>,
        sel,
      )}
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
  const dark = props.theme === 'dark';
  return (
    <div className="viewer">
      <Canvas shadows dpr={[1, 2]} camera={{ position: [2.6, 1.6, 6.4], fov: 40 }} onPointerMissed={() => props.onSelect(null)}>
        <ambientLight intensity={dark ? 0.35 : 0.6} />
        <directionalLight position={[4, 6, 5]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-5, 2, -4]} intensity={0.7} color="#7aa7ff" />
        <Environment resolution={128}>
          <Lightformer form="rect" intensity={2} position={[0, 5, -5]} scale={[10, 4, 1]} color="#ffffff" />
          <Lightformer form="rect" intensity={1.2} position={[-6, 1, 2]} scale={[3, 6, 1]} color="#8fb4ff" />
          <Lightformer form="rect" intensity={1.4} position={[6, 1, 2]} scale={[3, 6, 1]} color="#ffd9a0" />
        </Environment>
        <ModelError>
          <Suspense fallback={<Loader />}>
            <Bounds fit clip observe margin={1.35}>
              <Model {...props} tooltip={tooltip} />
            </Bounds>
          </Suspense>
        </ModelError>
        <ContactShadows position={[0, -2.3, 0]} opacity={dark ? 0.55 : 0.3} scale={12} blur={2.6} far={4} />
        <OrbitControls makeDefault enableDamping minDistance={2} maxDistance={20} />
      </Canvas>
      <div ref={tooltip} className="tooltip" />
    </div>
  );
}
