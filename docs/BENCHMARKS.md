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
