# Benchmarks

This repo ships a minimal but complete measurement loop:
- OpenAI-compatible proxy at :8080 with Prometheus metrics
- React UI that streams SSE and optional reasoning tokens
- Benchmark CLI (packages/bench) supporting single-run and concurrency sweeps + HTML report
- Playwright E2E that validates chat and metrics increments and runs a sweep

## Metrics (Prometheus)
Exposed at: http://localhost:8080/metrics

Core series (labels: runtime, model, status where applicable):
- chat_requests_total(runtime, model, status)
- chat_ttft_ms_bucket/sum/count(runtime, model)
- chat_duration_ms_bucket/sum/count(runtime, model)
- chat_tokens_total(runtime, model)
- chat_bytes_out_total(runtime, model)
- chat_in_flight(runtime, model)
- chat_upstream_headers_ms_bucket/sum/count(runtime, model)
- chat_errors_total(runtime, model, reason)
- build_info(version, node) = 1

Example PromQL (5m windows):
- Requests by status: sum(rate(chat_requests_total[5m])) by (status)
- TTFT p50: histogram_quantile(0.5, sum(rate(chat_ttft_ms_bucket[5m])) by (le))
- TTFT p95: histogram_quantile(0.95, sum(rate(chat_ttft_ms_bucket[5m])) by (le))
- Duration p50: histogram_quantile(0.5, sum(rate(chat_duration_ms_bucket[5m])) by (le))
- Tokens/s: rate(chat_tokens_total[5m])
- Bytes/s: rate(chat_bytes_out_total[5m])
- In flight: sum(chat_in_flight)

## Running the proxy and UI
- Backend: `pnpm -C apps/server-elide dev` (http://localhost:8080)
- UI: `pnpm -C apps/ui dev` (http://localhost:5173, proxied via :8080)

Set upstream LLM via env or UI Settings:
- LLM_BASE_URL (default http://localhost:1234/v1)
- LLM_API_KEY (default lm-studio)
- LLM_MODEL (default openai/gpt-oss-120b)

## Benchmark CLI
Build once: `pnpm -C packages/bench build`

- Smoke: `node packages/bench/dist/cli.js smoke --base-url=http://localhost:8080`
- Single run: `node packages/bench/dist/cli.js run --base-url=http://localhost:8080 --prompt="Explain Elide in one sentence."`
- Sweep (+HTML): `node packages/bench/dist/cli.js sweep --base-url=http://localhost:8080 --concurrency=8 --total=64 --prompt="..." --html`
  - Writes `bench-report.html`

Output fields:
- ttft (ms), tokens, duration (ms), tps (tokens/s)
- Sweeps: wall (ms), rps (req/s), tps (tokens/s), ttft_p50/p95, dur_p50/p95

## E2E tests
- Tests live in `packages/e2e/tests`
- Run: `pnpm -C packages/e2e test` (install browsers if prompted: `pnpm dlx playwright install`)
Tests include:
- UI loads and shows title
- Metrics increment on error-path chat (no upstream)
- Bench sweep runs and writes bench-report.html

## Grafana dashboard
A starter dashboard is provided at `docs/grafana/elide-openai-proxy.json`.
Import in Grafana and point to your Prometheus datasource.
Panels include requests by status, TTFT/Duration quantiles, tokens/s, bytes/s, and in-flight gauge.

## LM Studio quick run and interpretation
- Ensure LM Studio server is running (default http://localhost:1234/v1). UI Settings can be left default or set env LLM_BASE_URL, LLM_MODEL.
- Run a small sweep and write HTML:
  - `pnpm -C packages/bench build && node packages/bench/dist/cli.js sweep --base-url=http://localhost:8080 --concurrency=2 --total=8 --prompt="Explain Elide vs Node in one paragraph" --html`
  - Output JSON is printed and `bench-report.html` is written at repo root.

How to read it:
- TTFT: dominated by upstream model. Proxy overhead should be small. Compare `chat_upstream_headers_ms` (~a few ms) to TTFT (often seconds on CPU models).
- Duration: end-to-end stream time. Again dominated by model generation.
- Tokens/s and Bytes/s: throughput of streaming; mostly upstream capability.
- Requests by status: should be 200s during healthy runs; spikes in 5xx indicate upstream issues.

To isolate HTTP-serving overhead:
- Use the `chat_upstream_headers_ms` metric as a proxy for network + handshake overhead between server and LLM.
- For a stricter isolation, we can add a synthetic SSE endpoint that emits tokens at fixed intervals to measure pure proxy overhead. Say "add synthetic SSE" and we’ll wire it.


## Synthetic mode and in-repo baselines (Elide vs Express vs FastAPI)
Synthetic SSE eliminates the model; we stream fixed-size chunks at fixed intervals to measure serving overhead.

Config (env or request JSON):
- SYN_FRAMES: number of frames (default 200)
- SYN_DELAY_MS: delay between frames (default 5)
- SYN_BYTES: approximate bytes per frame (default 64)
- Request JSON can also set frames, delay_ms, bytes_per_frame

Start servers in separate terminals:
- Elide proxy (8080):
  - `pnpm -C apps/ui exec vite --port 5175`
  - `VITE_DEV_URL=http://localhost:5175 pnpm -C apps/server-elide dev`
- Express baseline (8081):
  - `pnpm -C apps/baseline-express dev`
- FastAPI baseline (8082):
  - Create venv, install deps: `python -m venv .venv && . .venv/Scripts/activate && pip install -r apps/baseline-fastapi/requirements.txt`
  - Run: `pnpm -C apps/baseline-fastapi dev`
- Flask baseline (8083):
  - Create venv, install deps: `python -m venv .venv && . .venv/Scripts/activate && pip install -r apps/baseline-flask/requirements.txt`
  - Run (gunicorn): `python -m gunicorn app.main:app -w 1 -b 0.0.0.0:8083` (cwd: apps/baseline-flask)

Run sweeps and write distinct HTML reports:
- Build once: `pnpm -C packages/bench build`
- Elide (8080):
  - `set LLM_MODEL=synthetic&& node packages/bench/dist/cli.js sweep --base-url=http://localhost:8080 --concurrency=8 --total=64 --prompt="synthetic" --html --out=bench-elide.html`
- Express (8081):
  - `set SYN_FRAMES=200&& set SYN_DELAY_MS=5&& set SYN_BYTES=64&& node packages/bench/dist/cli.js sweep --base-url=http://localhost:8081 --concurrency=8 --total=64 --prompt="synthetic" --html --out=bench-express.html`
- FastAPI (8082):
  - `set SYN_FRAMES=200&& set SYN_DELAY_MS=5&& set SYN_BYTES=64&& node packages/bench/dist/cli.js sweep --base-url=http://localhost:8082 --concurrency=8 --total=64 --prompt="synthetic" --html --out=bench-fastapi.html`
- Flask (8083):
  - `set SYN_FRAMES=200&& set SYN_DELAY_MS=5&& set SYN_BYTES=64&& node packages/bench/dist/cli.js sweep --base-url=http://localhost:8083 --concurrency=8 --total=64 --prompt="synthetic" --html --out=bench-flask.html`

## wrk2 mode (non-streaming HTTP baseline)
Use wrk2 for calibrated fixed-rate benchmarking against non-streaming endpoints to isolate HTTP serving overhead.

- Endpoints available on all baselines (and elide):
  - `/micro/plain?bytes=1024` (fixed-length plain text)
  - `/micro/chunked?bytes=1024&chunks=10&delay_ms=0` (chunked octet-stream)

Examples:
- macOS (Homebrew): `brew install wrk` (for wrk2, build from https://github.com/giltene/wrk2)
- Linux (Ubuntu): build wrk2 from source, then run:
  - `WRK_BIN=wrk2 WRK_URL=http://127.0.0.1:8081/micro/plain?bytes=1024 WRK_RATE=5000 WRK_DURATION=30s WRK_CONNECTIONS=128 WRK_THREADS=4 WRK_HTML=wrk2-express.html node packages/bench/dist/wrk2.js`
  - Repeat for :8080 (elide), :8082 (fastapi), :8083 (flask)

Notes:
- wrk (classic) does open-loop but not fixed rate; wrk2 supports `-R` for fixed rate. The runner accepts either via WRK_BIN.
- Prefer running all targets on the same machine and CPU governor for apples-to-apples.


Notes:
- On Git Bash/MSYS, avoid using a leading slash in a --path override; default path is /api/chat/completions so no override needed here.
- Compare TTFT, RPS, and CPU usage across the three reports; the synthetic mode highlights serving-layer differences only.
