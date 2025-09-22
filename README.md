# OpenHands–Elide Fork

A ready‑to‑run fork of OpenHands using Elide as the primary runtime and HTTP server, with Docker fallback. Includes:
- Elide server with synthetic SSE mode, micro HTTP tests, and Prometheus metrics
- React UI with live streaming, sparklines, error panels, and CLI orchestration
- Quad benchmark (Elide vs Express vs FastAPI vs Flask) with per‑run HTML results

## Prereqs
- Node 20+ and pnpm 9+: `npm i -g pnpm`
- Python 3.10+ (for FastAPI baseline)
- macOS/Linux or Windows via WSL (recommended)

## Quickstart (Linux/macOS/WSL)
1) Install deps (workspace root):
```
pnpm i -w
```
2) Dev mode (recommended): starts Elide server + Vite UI at http://localhost:8080
```
pnpm dev
```
3) Production build + run (serves built UI):
```
pnpm -C apps/ui build
pnpm -C apps/server-elide build
pnpm -C apps/server-elide start
```

## Docker (apples-to-apples) Quickstart
- Build workspace and Python images:
  - `docker compose -f infra/docker-compose.yml build node-workspace fastapi flask`
- Start the servers:
  - `docker compose -f infra/docker-compose.yml up -d elide express fastapi flask`
- Open the UI/bench at: http://localhost:8080
- Optional: run the quad bench (writes HTML under packages/bench/results):
  - `docker compose -f infra/docker-compose.yml run --rm bench`

Notes:
- Results are bind-mounted to `packages/bench/results/` on the host.
- Service endpoints in the docker network: `elide:8080`, `express:8081`, `fastapi:8082`, `flask:8083`.
- A wrk utility is available: `docker compose -f infra/docker-compose.yml --profile tools run --rm wrk wrk --help`.

## Playwright E2E (smoke)
- No need to pre-start servers; tests start the Elide server and UI automatically.
- Install Playwright browsers once: `pnpm dlx playwright install --with-deps`
- Run tests: `pnpm -C packages/e2e test`

## Handy scripts
- `pnpm docker:build` / `pnpm docker:up` / `pnpm docker:down` / `pnpm docker:bench`


## Using the Bench (from the UI)
- Single Run: fills fields above and clicks “Run” → shows live stats and a quick summary.
- Full sweep + save: runs standard tiers (8×64 → 128×512) and saves a UI JSON; visible under /results/index.html.
- Run via CLI (quad): launches the full Elide/Express/FastAPI/Flask sweep across your tiers.
  - Live panel shows CPU/RSS sparklines, per‑tier badges, and a color‑coded log (stderr in red).
  - When finished, you’ll get links: “Open results index” and “Open log”.

## Result files
- Per‑run outputs are written under:
  - packages/bench/results/runs/<timestamp>/
  - e.g., bench‑elide.64x256.html, bench‑express.64x256.html, bench‑fastapi.64x256.html, bench‑flask.64x256.html
- A run‑local index is generated for each run folder.
- The top‑level comparison lives at:
  - http://localhost:8080/results/index.html
  - This page lists all runs and links to each run’s index.

## Windows notes (WSL recommended)
- FastAPI baseline can build/run inside WSL if `QUAD_WSL_FASTAPI=1`.
- Node baselines can build/run inside WSL if `QUAD_WSL_NODE=1`.
- Ports used: 8080 (Elide), 8081 (Express), 8082 (FastAPI), 8083 (Flask). Free them if already taken.

## Troubleshooting
- If the UI shows an SSE MIME warning, refresh the page; the server now prioritizes stream routes.
- If trio run seems stuck, click “Cancel CLI” then retry. Logs are under packages/bench/results/cli-*.log.
- For persistent issues, check server console and /logs/stream in the UI.

See docs/ for detailed architecture (docs/ARCHITECTURE.md), runbook (docs/RUNBOOK.md), and benchmarks notes (docs/BENCHMARKS.md).
