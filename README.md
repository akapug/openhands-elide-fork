# OpenHands–Elide Fork

A ready‑to‑run fork of OpenHands using Elide as the primary runtime and HTTP server, with Docker fallback. Includes:
- Elide server with synthetic SSE mode, micro HTTP tests, and Prometheus metrics
- React UI with live streaming, sparklines, error panels, and CLI orchestration
- Trio benchmark (Elide vs Express vs FastAPI) with per‑run HTML results

## Prereqs
- Node 20+ and pnpm 9+: `npm i -g pnpm`
- Python 3.10+ (for FastAPI baseline)
- macOS/Linux or Windows via WSL (recommended)

## Quickstart (Linux/macOS/WSL)
1) Install deps (workspace root):
```
pnpm i -w
```
2) Build server + UI:
```
pnpm -C elide-hands/openhands-elide-fork/apps/server-elide build
pnpm -C elide-hands/openhands-elide-fork/apps/ui build
```
3) Start the Elide server (serves the built UI at http://localhost:8080):
```
node elide-hands/openhands-elide-fork/apps/server-elide/dist/index.js
```
Then open http://localhost:8080

## Using the Bench (from the UI)
- Single Run: fills fields above and clicks “Run” → shows live stats and a quick summary.
- Full sweep + save: runs standard tiers (8×64 → 128×512) and saves a UI JSON; visible under /results/index.html.
- Run via CLI (trio): launches the full Elide/Express/FastAPI sweep across your CSV tiers.
  - Live panel shows CPU/RSS sparklines, per‑tier badges, and a color‑coded log (stderr in red).
  - When finished, you’ll get links: “Open results index” and “Open log”.

## Result files
- Per‑run outputs are written under:
  - elide-hands/openhands-elide-fork/packages/bench/results/runs/<timestamp>/
  - e.g., bench‑elide.64x256.html, bench‑express.64x256.html, bench‑fastapi.64x256.html
- A run‑local index is generated for each run folder.
- The top‑level comparison lives at:
  - http://localhost:8080/results/index.html
  - This page lists all runs and links to each run’s index.

## Windows notes (WSL recommended)
- FastAPI baseline auto‑installs into a WSL venv if TRIO_WSL_FASTAPI=1.
- Node baselines can build inside WSL if TRIO_WSL_NODE=1.
- Ports used: 8080 (Elide), 8081 (Express), 8082 (FastAPI). Free them if already taken.

## Troubleshooting
- If the UI shows an SSE MIME warning, refresh the page; the server now prioritizes stream routes.
- If trio run seems stuck, click “Cancel CLI” then retry. Logs are under packages/bench/results/cli-*.log.
- For persistent issues, check server console and /logs/stream in the UI.

See docs/ for detailed architecture (docs/ARCHITECTURE.md), runbook (docs/RUNBOOK.md), and benchmarks notes (docs/BENCHMARKS.md).
