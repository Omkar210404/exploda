"""Self-test: python selftest.py  (no key or network needed). Prints PASS/FAIL per step."""
import json
import os
import struct
import sys

os.environ["AI_PROVIDER"] = "mock"
from fastapi.testclient import TestClient  # noqa: E402

import app as backend  # noqa: E402

client = TestClient(backend.app)
EXPECTED = {"Medical / Human Body", "Automotive", "Science", "Other"}


def glb_mesh_names(path):
    with open(path, "rb") as f:
        magic, _, _ = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67, "not a GLB file"
        length, kind = struct.unpack("<II", f.read(8))
        assert kind == 0x4E4F534A, "first chunk is not JSON"
        gltf = json.loads(f.read(length))
    return {n["name"] for n in gltf["nodes"] if "mesh" in n}


def models():
    return [m for c in backend.load_manifest()["categories"] for m in c["models"] if not m.get("comingSoon")]


def test_manifest():
    cats = backend.load_manifest()["categories"]
    assert EXPECTED == {c["name"] for c in cats}, f"categories: {[c['name'] for c in cats]}"
    assert models(), "no models in manifest"
    return f"{len(cats)} categories, {len(models())} models"


def test_parts_match_meshes():
    out = []
    for m in models():
        path = backend.MODELS_DIR / m["folder"] / m["file"]
        size = path.stat().st_size
        assert size < 5 * 1024 * 1024, f"{m['id']} is {size} bytes (limit 5 MB)"
        meshes, parts = glb_mesh_names(path), backend.load_parts(m)
        assert set(parts) <= meshes, f"{m['id']}: parts without a mesh: {set(parts) - meshes}"
        assert meshes <= set(parts), f"{m['id']}: meshes without parts data: {meshes - set(parts)}"
        for k, p in parts.items():
            assert p.get("name") and p.get("description") and p.get("facts"), f"{m['id']}/{k} incomplete"
        out.append(f"{m['id']} {len(parts)}/{len(meshes)}")
    return ", ".join(out)


def test_ai_mock():
    s = client.get("/api/status").json()
    assert s["configured"] and s["provider"] == "mock", s
    r = client.post("/api/chat", json={"model_id": "heart", "part_id": "mitral_valve",
                                       "messages": [{"role": "user", "content": "What does it do?"}]})
    assert r.status_code == 200 and "Mitral Valve" in r.text and "left atrium" in r.text, r.text
    bad = client.post("/api/chat", json={"model_id": "heart", "part_id": "nope",
                                         "messages": [{"role": "user", "content": "hi"}]})
    assert bad.status_code == 404
    return "streamed grounded answer, unknown part -> 404"


def test_not_configured():
    os.environ["AI_PROVIDER"] = ""
    try:
        assert client.get("/api/status").json()["configured"] is False
        r = client.post("/api/chat", json={"model_id": "heart", "part_id": "aorta",
                                           "messages": [{"role": "user", "content": "hi"}]})
        assert r.status_code == 503 and "AI not configured" in r.json()["detail"]
    finally:
        os.environ["AI_PROVIDER"] = "mock"
    return "no provider -> 503 'AI not configured'"


if __name__ == "__main__":
    steps = [("category manifest loads", test_manifest), ("parts data maps to meshes", test_parts_match_meshes),
             ("AI backend via mock provider", test_ai_mock), ("no provider -> not configured", test_not_configured)]
    failed = 0
    for label, fn in steps:
        try:
            print(f"PASS  {label}: {fn()}")
        except Exception as e:
            failed += 1
            print(f"FAIL  {label}: {e}")
    print(f"\n{len(steps) - failed}/{len(steps)} passed")
    sys.exit(1 if failed else 0)
