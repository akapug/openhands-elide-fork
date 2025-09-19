import os
import asyncio
import time
from starlette.middleware.gzip import GZipMiddleware

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, PlainTextResponse, JSONResponse
import httpx

app = FastAPI(title="baseline-fastapi", version="0.1.0")
if str(os.getenv("SYN_GZIP", "")).lower() in ("1", "true"):
    app.add_middleware(GZipMiddleware, minimum_size=0)


@app.get("/healthz")
async def healthz():
    return PlainTextResponse("ok\n")

@app.post("/tool")
async def tool(req: Request):
    body = await req.json()
    cpu_spin_ms = int(body.get("cpu_spin_ms", os.getenv("SYN_CPU_SPIN_MS", 0)))

    def spin(ms: int):
        if ms <= 0:
            return
        end = time.perf_counter() + (ms / 1000.0)
        while time.perf_counter() < end:
            pass

    if cpu_spin_ms > 0:
        spin(cpu_spin_ms)
    return JSONResponse({"ok": True})

@app.post("/api/chat/completions")
async def chat(req: Request):
    body = await req.json()
    frames = int(body.get("frames", os.getenv("SYN_FRAMES", 200)))
    delay_ms = int(body.get("delay_ms", os.getenv("SYN_DELAY_MS", 5)))
    bytes_per_frame = int(body.get("bytes_per_frame", os.getenv("SYN_BYTES", 64)))
    cpu_spin_ms = int(body.get("cpu_spin_ms", os.getenv("SYN_CPU_SPIN_MS", 0)))
    fanout = int(body.get("fanout", os.getenv("SYN_FANOUT", 0)))
    fanout_delay_ms = int(body.get("fanout_delay_ms", os.getenv("SYN_FANOUT_DELAY_MS", 0)))

    word = "x"
    words_per_frame = max(1, bytes_per_frame // (len(word) + 1))

    def spin(ms: int):
        if ms <= 0:
            return
        end = time.perf_counter() + (ms / 1000.0)
        while time.perf_counter() < end:
            pass

    async def gen():
        try:
            # Pre-stream fanout (simulate upstream calls)
            fanout_http = str(os.getenv("SYN_FANOUT_HTTP", "")).lower() in ("1", "true")
            for _ in range(fanout):
                if fanout_delay_ms > 0:
                    await asyncio.sleep(fanout_delay_ms / 1000)
                if fanout_http:
                    try:
                        async with httpx.AsyncClient() as client:
                            await client.post("http://127.0.0.1:8082/tool", json={"cpu_spin_ms": cpu_spin_ms}, timeout=10.0)
                    except Exception:
                        pass
                else:
                    if cpu_spin_ms > 0:
                        spin(cpu_spin_ms)

            for _ in range(frames):
                if cpu_spin_ms > 0:
                    spin(cpu_spin_ms)
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

