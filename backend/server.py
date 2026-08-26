"""
AIToolsNova - FastAPI backend for /api/gemini AI Chat endpoint.
Uses Emergent LLM Key via emergentintegrations library.

Security (Aug 2026 hardening):
  - CORS restricted to explicit origins (was allow_origins=["*"] with
    allow_credentials=True — an invalid/dangerous combination).
  - Naive in-memory per-IP rate limiting on the AI endpoint.
  - Error responses are generic; exception details stay in server logs
    (they previously went straight to the client).
  - Newsletter `source` is truncated and shape-checked before storage.
  - Subscriber PII is written outside the repo tree by default and the
    file is gitignored, so it can never be committed or deployed.
"""
import os
import re
import time
import uuid
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr, Field

# Load env vars before importing anything that needs them
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: E402

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")

# Comma-separated allowlist. Preview origins included for local dev only.
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "ALLOWED_ORIGINS",
        "https://aitoolsnova.com,https://www.aitoolsnova.com,http://localhost:3000,http://127.0.0.1:3000",
    ).split(",")
    if o.strip()
]

app = FastAPI(title="AIToolsNova API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ---------- Naive per-IP rate limiting (single-process, best-effort) ----------
RATE_LIMITS = {"/api/gemini": (30, 60), "/api/subscribe": (5, 60)}  # (max, window_s)
_ip_hits: dict[str, list[float]] = defaultdict(list)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    limit_cfg = RATE_LIMITS.get(request.url.path)
    if limit_cfg:
        max_calls, window_s = limit_cfg
        ip = request.client.host if request.client else "unknown"
        now = time.time()
        recent = [t for t in _ip_hits[ip] if now - t < window_s]
        recent.append(now)
        _ip_hits[ip] = recent
        if len(recent) > max_calls:
            raise HTTPException(status_code=429, detail="Too many requests. Please try again later.")
        # opportunistic cleanup
        if len(_ip_hits) > 10_000:
            for k in list(_ip_hits.keys()):
                _ip_hits[k] = [t for t in _ip_hits[k] if now - t < window_s]
                if not _ip_hits[k]:
                    del _ip_hits[k]
    return await call_next(request)


class ChatRequest(BaseModel):
    message: str = Field(max_length=12_000)


class ChatResponse(BaseModel):
    reply: str
    provider: str


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "aitoolsnova-api"}


@app.post("/api/gemini", response_model=ChatResponse)
async def ai_chat(payload: ChatRequest):
    """AI Chat endpoint used by the AI Chat, AI Writer, Email Generator etc. tools."""
    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required")

    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="AI provider is not configured")

    system_message = (
        "You are AIToolsNova's helpful assistant. Give concise, well-structured answers "
        "in Markdown-free plain text. Be friendly, accurate and practical."
    )

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"aitoolsnova-{uuid.uuid4().hex[:12]}",
        system_message=system_message,
    ).with_model("gemini", "gemini-2.5-flash")

    try:
        reply = await chat.send_message(UserMessage(text=message))
    except Exception as exc:
        # Log the real cause server-side; the client gets a generic message.
        print(f"[ai_chat] provider error: {exc!r}")
        raise HTTPException(status_code=500, detail="AI provider error. Please try again.")

    reply_text = str(reply).strip() if reply else "Sorry, no response was generated."
    return ChatResponse(reply=reply_text, provider="gemini-2.5-flash")


# ---------- Newsletter Subscribe ----------
# PII lives outside the repo by default so it can never be committed/deployed.
SUBSCRIBERS_FILE = Path(
    os.environ.get("SUBSCRIBERS_FILE", "/app/data/subscribers.jsonl")
)


class SubscribeRequest(BaseModel):
    email: EmailStr
    source: str | None = Field(default=None, max_length=200)


@app.post("/api/subscribe")
async def subscribe(payload: SubscribeRequest):
    """Store newsletter subscriber email in a local file (JSONL)."""
    email = str(payload.email).lower().strip()
    source = (payload.source or "unknown").strip()[:120]
    if not re.fullmatch(r"[a-z0-9/_.\-?=#%]*", source, re.IGNORECASE):
        source = "unknown"
    entry = {
        "id": uuid.uuid4().hex,
        "email": email,
        "source": source,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        SUBSCRIBERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with SUBSCRIBERS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as exc:
        print(f"[subscribe] storage error: {exc!r}")
        raise HTTPException(status_code=500, detail="Could not save subscriber. Please try again.")
    return {"ok": True, "message": "Subscribed successfully"}


# Local runner (supervisor uses uvicorn command instead)
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
