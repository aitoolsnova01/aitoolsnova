"""
AIToolsNova - FastAPI backend for /api/gemini AI Chat endpoint.
Uses Emergent LLM Key via emergentintegrations library.
"""
import os
import uuid
import json
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, EmailStr

# Load env vars before importing anything that needs them
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

from emergentintegrations.llm.chat import LlmChat, UserMessage  # noqa: E402

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY")

app = FastAPI(title="AIToolsNova API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


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
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not configured")

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
        raise HTTPException(status_code=500, detail=f"AI provider error: {exc}")

    reply_text = str(reply).strip() if reply else "Sorry, no response was generated."
    return ChatResponse(reply=reply_text, provider="gemini-2.5-flash")


# ---------- Newsletter Subscribe ----------
SUBSCRIBERS_FILE = ROOT_DIR / "subscribers.jsonl"


class SubscribeRequest(BaseModel):
    email: EmailStr
    source: str | None = None


@app.post("/api/subscribe")
async def subscribe(payload: SubscribeRequest):
    """Store newsletter subscriber email in a local file (JSONL)."""
    email = str(payload.email).lower().strip()
    entry = {
        "id": uuid.uuid4().hex,
        "email": email,
        "source": payload.source or "unknown",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        with SUBSCRIBERS_FILE.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not save subscriber: {exc}")
    return {"ok": True, "message": "Subscribed successfully"}


# Local runner (supervisor uses uvicorn command instead)
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8001)
