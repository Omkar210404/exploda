"""Self-test: python selftest.py  (no key or network needed). Prints PASS/FAIL per step."""
import fnmatch
import json
import os
import struct
import sys

os.environ["AI_PROVIDER"] = "mock"
from fastapi.testclient import TestClient  # noqa: E402

import app as backend  # noqa: E402

client = TestClient(backend.app)
EXPECTED = {"Medical / Human Body", "Automotive", "Science", "Other"}


def glb_nodes(path):
    with open(path, "rb") as f:
        magic, _, _ = struct.unpack("<III", f.read(12))
        assert magic == 0x46546C67, "not a GLB file"
        length, kind = struct.unpack("<II", f.read(8))
        assert kind == 0x4E4F534A, "first chunk is not JSON"
        return json.loads(f.read(length))["nodes"]


def resolve(nodes, parts):
    """Same rule as the viewer: a mesh belongs to the nearest named ancestor matching a part pattern."""
    parent = {c: i for i, n in enumerate(nodes) for c in n.get("children", [])}
    rules = [(pid, pat) for pid, p in parts.items() for pat in p.get("meshes", [pid])]
    found = {}
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        j = i
        while j is not None:
            hits = [(len(pat), pid) for pid, pat in rules if fnmatch.fnmatchcase(nodes[j].get("name", ""), pat)]
            if hits:
                found[i] = max(hits)[1]
                break
            j = parent.get(j)
    return found


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
        nodes, parts = glb_nodes(path), backend.load_parts(m)
        found = resolve(nodes, parts)
        empty = set(parts) - set(found.values())
        assert not empty, f"{m['id']}: parts with no mesh: {empty}"
        for k, p in parts.items():
            assert p.get("name") and p.get("description") and p.get("facts"), f"{m['id']}/{k} incomplete"
        total = sum("mesh" in n for n in nodes)
        out.append(f"{m['id']} {len(parts)} parts ({len(found)}/{total} meshes)")
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
    simple = client.post("/api/chat", json={"model_id": "brain", "part_id": "cerebellum", "style": "simple",
                                            "messages": [{"role": "user", "content": "What is it?"}]})
    assert simple.status_code == 200 and "Cerebellum" in simple.text, simple.text
    wrong = client.post("/api/chat", json={"model_id": "heart", "part_id": "aorta", "style": "pirate",
                                           "messages": [{"role": "user", "content": "hi"}]})
    assert wrong.status_code == 422
    assert "very simple words" in backend.build_system_prompt(backend.find_model("heart"), backend.load_parts(backend.find_model("heart")), "aorta", "simple")
    return "streamed grounded answer, answer styles, unknown part -> 404"


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
