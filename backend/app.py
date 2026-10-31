"""Exploda backend: grounded, streaming AI chat about one part of a 3D model.

The frontend never sends facts or keys. It sends (model_id, part_id, messages);
the backend looks the part up in the same parts.json the viewer uses.
"""
import json
import os
from pathlib import Path
from typing import AsyncIterator, Literal

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = Path(os.getenv("EXPLODA_MODELS_DIR", ROOT / "frontend" / "public" / "models"))


def load_env(path: Path = Path(__file__).with_name(".env")) -> None:
    """Minimal .env reader; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()


# ---------- library ----------
def load_manifest() -> dict:
    return json.loads((MODELS_DIR / "manifest.json").read_text(encoding="utf-8"))


def find_model(model_id: str) -> dict | None:
    for cat in load_manifest()["categories"]:
        for m in cat["models"]:
            if m["id"] == model_id and not m.get("comingSoon"):
                return m
    return None


def load_parts(model: dict) -> dict:
    return json.loads((MODELS_DIR / model["folder"] / model["parts"]).read_text(encoding="utf-8"))


NOT_SURE = "I'm not sure - that goes beyond the notes I have for this part."


STYLES = {
    "simple": "Explain in very simple words, as if to a 12-year-old: short sentences, no jargon.",
    "standard": "Keep answers short (2-5 sentences) and in plain language.",
    "technical": "Answer like a specialist, using the precise technical terms that appear in the notes. Keep it to 2-5 sentences.",
}


def build_system_prompt(model: dict, parts: dict, part_id: str, style: str = "standard") -> str:
    part = parts[part_id]
    facts = "\n".join(f"- {f}" for f in part["facts"])
    others = ", ".join(p["name"] for k, p in parts.items() if k != part_id)
    return (
        f'You are a tutor inside Exploda, a 3D learning app. The user selected the "{part["name"]}" '
        f'in the "{model["name"]}" model.\n'
        "Answer using ONLY the reference notes below. If the notes do not contain the answer, reply "
        f'"{NOT_SURE}" and briefly say what the notes do cover. Never invent numbers, names or facts, '
        "whatever the answer style.\n"
        f"{STYLES[style]}\n\n"
        f"Reference notes for {part['name']}:\nDescription: {part['description']}\nFacts:\n{facts}\n"
        f"Other parts in this model: {others}"
    )


# ---------- providers ----------
class Provider:
    name = "none"
    model: str | None = None

    async def status(self) -> tuple[bool, str]:
        return False, "Set AI_PROVIDER to ollama or gemini in backend/.env (see .env.example)."

    async def stream(self, system: str, messages: list[dict]) -> AsyncIterator[str]:
        raise NotImplementedError
        yield ""


class MockProvider(Provider):
    """Offline provider for the self-test: repeats the grounded description."""
    name = "mock"

    async def status(self):
        return True, "Mock provider (offline, for tests)."

    async def stream(self, system, messages):
        notes = system.split("Description: ", 1)[1].split("\n", 1)[0]
        name = system.split('selected the "', 1)[1].split('"', 1)[0]
        for word in f"[mock] {name}: {notes}".split(" "):
            yield word + " "


class OllamaProvider(Provider):
    name = "ollama"

    def __init__(self):
        self.host = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
        self.model = os.getenv("OLLAMA_MODEL", "llama3.2:3b")

    async def status(self):
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                tags = (await c.get(f"{self.host}/api/tags")).json()
        except httpx.HTTPError:
            return False, f"Ollama is not reachable at {self.host}. Start Ollama, then reopen this panel."
        names = {m["name"] for m in tags.get("models", [])}
        if self.model not in names and f"{self.model}:latest" not in names:
            return False, f"Ollama model '{self.model}' is not pulled. Run: ollama pull {self.model}"
        return True, "Local Ollama"

    async def stream(self, system, messages):
        body = {"model": self.model, "stream": True, "options": {"temperature": 0.2},
                "messages": [{"role": "system", "content": system}, *messages]}
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=5)) as c:
            async with c.stream("POST", f"{self.host}/api/chat", json=body) as r:
                r.raise_for_status()
                async for line in r.aiter_lines():
                    if line.strip():
                        chunk = json.loads(line).get("message", {}).get("content", "")
                        if chunk:
                            yield chunk


class GeminiProvider(Provider):
    name = "gemini"

    def __init__(self):
        self.key = os.getenv("GEMINI_API_KEY", "")
        self.model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash")

    async def status(self):
        if not self.key:
            return False, "GEMINI_API_KEY is empty in backend/.env."
        return True, "Gemini free tier"

    async def stream(self, system, messages):
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:streamGenerateContent?alt=sse"
        body = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                         for m in messages],
            "generationConfig": {"temperature": 0.2},
        }
        # key goes in a header, so it never appears in URLs or error messages
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5)) as c:
            async with c.stream("POST", url, json=body, headers={"x-goog-api-key": self.key}) as r:
                if r.status_code != 200:
                    raise RuntimeError(f"Gemini returned HTTP {r.status_code}")
                async for line in r.aiter_lines():
                    if line.startswith("data: "):
                        data = json.loads(line[6:])
                        for cand in data.get("candidates", []):
                            for p in cand.get("content", {}).get("parts", []):
                                if p.get("text"):
                                    yield p["text"]


PROVIDERS = {"mock": MockProvider, "ollama": OllamaProvider, "gemini": GeminiProvider}


def get_provider() -> Provider:
    return PROVIDERS.get(os.getenv("AI_PROVIDER", "").strip().lower(), Provider)()


# ---------- API ----------
app = FastAPI(title="Exploda")


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=4000)


class ChatRequest(BaseModel):
    model_id: str
    part_id: str
    messages: list[Message] = Field(min_length=1, max_length=40)
    style: Literal["simple", "standard", "technical"] = "standard"


@app.get("/api/status")
async def status():
    p = get_provider()
    ok, detail = await p.status()
    return {"configured": ok, "provider": p.name, "model": p.model, "detail": detail}


@app.post("/api/chat")
async def chat(req: ChatRequest):
    model = find_model(req.model_id)
    if not model:
        raise HTTPException(404, "Unknown model.")
    parts = load_parts(model)
    if req.part_id not in parts:
        raise HTTPException(404, "Unknown part.")
    if req.messages[-1].role != "user":
        raise HTTPException(422, "The last message must be from the user.")
    provider = get_provider()
    ok, detail = await provider.status()
    if not ok:
        raise HTTPException(503, f"AI not configured. {detail}")

    system = build_system_prompt(model, parts, req.part_id, req.style)
    history = [m.model_dump() for m in req.messages[-12:]]

    async def gen():
        try:
            async for chunk in provider.stream(system, history):
                yield chunk
        except Exception as e:  # report the failure in the stream, never the key
            why = str(e) if isinstance(e, RuntimeError) else type(e).__name__
            yield f"\n\n[AI error: {why}. Check the provider and try again.]"

    return StreamingResponse(gen(), media_type="text/plain; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# serve the built frontend if it exists (npm run build), so one process runs everything
DIST = ROOT / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
