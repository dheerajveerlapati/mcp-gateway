"""Chat endpoint. The browser keeps the conversation and sends it each time,
so the server stores no chat history; the answer streams back as events."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.agent import run_chat, to_sse
from app.auth import current_user
from app.db import User

router = APIRouter(prefix="/api/chat", tags=["chat"])

MAX_HISTORY = 20  # messages sent to the model; keeps requests small


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)


@router.post("")
async def chat(body: ChatRequest, user: User = Depends(current_user)) -> StreamingResponse:
    if body.messages[-1].role != "user":
        raise HTTPException(422, "The last message must come from the user.")
    history = [m.model_dump() for m in body.messages[-MAX_HISTORY:]]

    async def stream():
        async for event in run_chat(user, history):
            yield to_sse(event)
        yield to_sse({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
