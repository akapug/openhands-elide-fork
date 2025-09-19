import os
import asyncio
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, PlainTextResponse

app = FastAPI(title="baseline-fastapi", version="0.1.0")

@app.get("/healthz")
async def healthz():
    return PlainTextResponse("ok\n")

@app.post("/api/chat/completions")
async def chat(req: Request):
    body = await req.json()
    frames = int(body.get("frames", os.getenv("SYN_FRAMES", 200)))
    delay_ms = int(body.get("delay_ms", os.getenv("SYN_DELAY_MS", 5)))
    bytes_per_frame = int(body.get("bytes_per_frame", os.getenv("SYN_BYTES", 64)))
    word = "x"
    words_per_frame = max(1, bytes_per_frame // (len(word) + 1))

    async def gen():
        try:
            for _ in range(frames):
                text = (word + " ") * words_per_frame
                payload = {"choices": [{"delta": {"content": text}}]}
                yield ("data: " + __import__("json").dumps(payload) + "\n\n").encode("utf-8")
                if delay_ms > 0:
                    await asyncio.sleep(delay_ms / 1000)
            yield b"data: [DONE]\n\n"
        except Exception as e:
            yield ("data: " + __import__("json").dumps({"error": str(e)}) + "\n\n").encode("utf-8")
            yield b"data: [DONE]\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")

