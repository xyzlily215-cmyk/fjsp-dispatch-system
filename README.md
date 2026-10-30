# Dynamic FJSP Scheduling & Simulation Decision System

English | [简体中文](README.zh-CN.md)

<div align="center">

**Dynamic flexible job-shop scheduling with an agentic copilot: baseline scheduling, disturbance handling, plan review & release, execution feedback — all auditable.**

<img src="https://img.shields.io/badge/license-MIT-2F4F4F" alt="License: MIT" />
<img src="https://img.shields.io/badge/Java-17%20%C2%B7%20Spring%20Boot%203.5-6DB33F" alt="Java 17 / Spring Boot 3.5" />
<img src="https://img.shields.io/badge/Python-3.12%20%C2%B7%20FastAPI-3776AB" alt="Python 3.12 / FastAPI" />
<img src="https://img.shields.io/badge/Vue-3%20%C2%B7%20Vite%20%C2%B7%20Element%20Plus-42B883" alt="Vue 3 / Vite / Element Plus" />
<img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL 16" />

[Demo Video](#demo-video) · [Architecture](#architecture) · [Integration Standards](#integration-standards) · [Quick Start](#quick-start)

</div>

An undergraduate capstone project: a full-loop production scheduling and simulation decision system for a single dynamic flexible job shop, covering **master data → baseline scheduling → disturbance events (machine breakdown / urgent order insertion) → local / full rescheduling → plan comparison → review & release → execution feedback**. The system runs an agentic AI copilot on top of [Agnes Harness (AGH)](https://github.com/AgnesAI-Labs/agnes-harness) and can attach to workshop devices through MHS/AgnesHub for a digital-twin experience.

## Project Overview

### Background

Real flexible job shops still rely on manual experience or static scheduling. When disturbances strike — an urgent order, a machine breakdown — the plan must be reworked by hand, which easily causes resource conflicts (overlapping machine time), process-route violations, and unquantifiable due-date slippage. The adjustment process also lacks explainable plan comparison and approval traceability, making decisions hard to audit.

This project builds and validates a closed loop of **dynamic scheduling decisions + explainable presentation + human-in-the-loop governance**.

### Core Features

- **Baseline scheduling**: one-click scheduling over master data (demo scale: 20 orders / 8 machines / 3 product families; upper bound 50/12), producing a plan version with KPIs (makespan C_max, weighted tardiness, load imbalance, plan disturbance Δ_plan).
- **Disturbance handling**: register breakdown / order-insertion events, compute the affected-operation set (with HARD_LOCKED / ADJUSTABLE classification and freeze-window rules), then run local or full rescheduling.
- **Plan governance**: full state machine `DRAFT → REVIEW_PENDING → REVIEWED → PUBLISHED → EXECUTING`, with rejection/revise paths, optimistic locking, staleness checks and a hard-constraint integrity guard at release time.
- **Execution feedback**: report operation RUNNING/COMPLETED; the first RUNNING report flips the plan to EXECUTING; in-progress operations are locked via an `actualStartAt` anchoring protocol during rescheduling.
- **AI dispatch copilot**: an AGH-driven agent that operates the whole business loop in natural language through 18 `fjsp_*` tools, with tiered human approval for every write/high-risk action, an RSI experience loop (past handling strategies are recorded and recommended for similar events), and full-trace auditing.
- **Digital-twin workshop**: 8 virtual CNC machines + 1 AGV connected through MHS/AgnesHub — status/metrics/panel images, workshop map, fault injection, and automatic agent wake-up on device alarms.
- **Web console**: 20 Vue views — dashboard, Gantt chart, plan comparison, task queue, review queue, execution feedback, agent trace timeline, digital twin, and more.

### Innovation Highlights

- **Self-developed hybrid genetic algorithm** (`event-adaptive-hga-1.0.0`): event-adaptive local/full rescheduling with freeze-window and hard-lock semantics, validated by a second `/validate` pass on the business side.
- **Agent-native operation**: business capabilities are exposed as AGH tool plugins and as an MCP server from the same source; approval semantics (READ / WRITE / HIGH_RISK / DESTRUCTIVE) guarantee that review and release stay human decisions.
- **RSI experience loop**: every disturbance handling is distilled into an experience record (JSONL + RAG retrieval with vector embeddings and BM25), so the agent recommends the historically best strategy for similar events.
- **Enterprise-grade reliability**: idempotency keys, optimistic locking, unique partial index for a single active plan, audit log on every key write, task retry/timeout/startup-recovery, and collaborative cancellation.

## Demo Video

- **Demo video (3–5 min, Baidu Netdisk)**: <https://pan.baidu.com/s/1Sa8LUACkWuJmYwFUZr9mFw?pwd=pbh7> (extraction code: `pbh7`)
- The video walks through baseline scheduling → publishing, machine-breakdown handling with the AI copilot, plan comparison and review, and the digital-twin workshop.

## Architecture

```text
┌──────────────────┐  HTTPS/JWT   ┌────────────────────┐  HTTP /solve /validate  ┌─────────────────────┐
│ web-vue          │ ───────────▶ │ business-service   │ ──────────────────────▶ │ algorithm-service   │
│ Vue 3 + Vite     │ ◀── SSE ──── │ Spring Boot 3.5    │ ◀──── plan + KPIs ──── │ FastAPI + hybrid GA │
│ Element Plus     │              │ Spring Data JPA    │                         │ event-adaptive-hga  │
│ ECharts (static) │              │ PostgreSQL 16      │                         └─────────────────────┘
└────────┬─────────┘              └─────────▲──────────┘
         │ /agent-api (HTTP/SSE)            │ REST /api/v1 (JWT, idempotency, optimistic lock)
┌────────▼─────────┐              ┌─────────┴──────────┐
│ agent-bff        │              │ fjsp-tools plugin  │ ── MCP server (stdio, protocol 2025-06-18)
│ Node (tsx) :4178 │              │ 18 fjsp_* tools    │
└────────┬─────────┘              └─────────▲──────────┘
         │ unix socket (AGH SDK)            │ agnes.plugins entry
┌────────▼──────────────────────────────────┴───────────┐   MHS over WebSocket   ┌───────────────────┐
│ Agnes Harness (AGH) runtime — LLM + skills + approvals │ ◀──────────────────── │ MHS devices       │
│ workbench :4177 · hub (AgnesHub) :4180                 │    AgnesHub :4180     │ 8 CNC + 1 AGV     │
└────────────────────────────────────────────────────────┘                       └───────────────────┘
```

### Modules

| Module | Stack | Responsibility |
|---|---|---|
| `algorithm-service/` | Python 3.12, FastAPI | Scheduling kernel: `/solve`, `/validate`, `/health`; hybrid GA with event-adaptive rescheduling, freeze windows and locking consistency checks; serialized solving to avoid GIL contention |
| `business-service/` | Java 17, Spring Boot 3.5, JPA + Flyway, PostgreSQL 16 | Persistence, events, impact-set computation, async task orchestration (retry/timeout/recovery), plan versions, review & release, execution feedback, JWT auth, audit |
| `web-vue/` | Vue 3, Vite, Element Plus, Pinia, ECharts | Static-built SPA console (hash routing), 20 views, AI copilot sidebar and in-page insight cards |
| `agh-integration/` | AGH plugins / Node (tsx) / Python | `fjsp-tools` plugin (18 tools), `agent-bff` (AGH→HTTP/SSE bridge + MCP server + RAG experience retrieval), MHS virtual devices, `fjsp-dispatch` skill, end-to-end drivers |
| `deploy/` | Docker Compose | PostgreSQL 16 (bound to 127.0.0.1) |
| `scripts/` | Bash / Node | One-click start/stop/reset, smoke test, e2e API check, perf baseline, evidence collection |

Default ports: web **8082** · business API **8081** · algorithm **8101** · AGH workbench **4177** · agent-bff **4178** · AgnesHub **4180**.

## Integration Standards

### Business REST API (`/api/v1`)

- **Unified envelope**: every response is `{requestId, timestamp, code, message, data}`; `requestId` is propagated through logs via MDC and returned even on 401/403.
- **Pagination contract**: list endpoints return `data: {items, page, size, total, totalPages}` (page starts at 0, default size 20, max 200; operations endpoint allows up to 5000).
- **AuthN/AuthZ**: stateless JWT (`Authorization: Bearer <token>`, HS256, 8h TTL) with four roles — DISPATCHER / REVIEWER / PRODUCTION_MANAGER / ADMIN; role invalidation is immediate via a `tv` (tokenVersion) claim checked against the database on every request. Login is rate-limited (5 failures → 10 min lock, HTTP 429). SSE streams use one-time 60-second tickets instead of bearer tokens.
- **Idempotency**: write endpoints require an `Idempotency-Key`; the same key + same payload digest returns the original result within 24h, the same key + different digest returns `E_DUPLICATE`. Scheduling tasks additionally deduplicate by input-snapshot fingerprint (SHA-256).
- **Optimistic locking**: review/release transitions carry the current `version`; mismatches return `409 E_VERSION_STALE`. A partial unique index (`uq_plan_version_single_active`) guarantees a single active plan at the database level.
- **Time & errors**: all timestamps are UTC `timestamptz`, serialized as ISO 8601; business errors use stable codes (`E_VALIDATION`, `E_STATE_CONFLICT`, `E_PLAN_STALE`, `E_INTEGRITY_VIOLATION`, `E_EVENT_IN_PROCESS`, …). Full endpoint list and role matrix: [`business-service/README.md`](business-service/README.md).

### Algorithm Service Contract

- `POST /solve` — input: machines/calendars, orders/operations, mode (`BASELINE` / `LOCAL_RESCHEDULE` / `FULL_RESCHEDULE`), lockings (with `actualStartAtMinutes` anchoring), freeze window, objective weights, seed. Output: scheduled operations + KPIs, or `INFEASIBLE` with structured conflicts.
- `POST /validate` — independent re-check of a candidate plan against all hard constraints; the business service always validates before persisting and before publishing.
- `GET /health` — liveness with service/algorithm versions.

### Agent Integration (AGH plugin, MCP, MHS)

- **AGH tool plugin** (`agh-integration/fjsp-tools`): dependency-free single-file ESM declared via `agnes.plugins`; all 18 `fjsp_*` tools call the business REST API, auto-generate idempotency keys, and pass business error codes through to the agent. Every request carries audit headers `X-Source: agh` and `X-AGH-Session-Id`.
- **Tiered approval**: READ tools never ask; WRITE tools always ask (idempotent replay); HIGH_RISK (`fjsp_approve_review`, `fjsp_publish`) and DESTRUCTIVE (`fjsp_reset_demo`) always ask and never replay — review approval and release are two separate human decision points, and the agent never auto-approves.
- **MCP server** (`agh-integration/agent-bff/mcp-server.mts`): exposes the same tool implementations over Model Context Protocol (stdio/NDJSON, protocol 2025-06-18) to any MCP client; write/high-risk tools require an explicit `"_confirm": true` argument, the MCP-side equivalent of AGH human approval.
- **agent-bff** (`agh-integration/agent-bff/server.mts`): bridges the AGH daemon to same-origin HTTP/SSE for the web console (`/agent-api/chat`, `/stream`, `/permission`, `/twin/*`, `/rag/experience-query`); binds to 127.0.0.1 with loopback Origin checks.
- **MHS devices** (`agh-integration/mhs-devices`): virtual CNC machines and an AGV register state, metrics, panel-image streams and workshop maps to AgnesHub over WebSocket; device alarms wake the agent, which handles them through the standard `fjsp_*` approval chain. Integration details: [`agh-integration/README.md`](agh-integration/README.md).

## Quick Start

Prerequisites: Docker (Compose v2), Python 3.12, Node.js 22, JDK 17, Maven, Bash, curl. Windows users: run inside WSL2 Ubuntu (see the [Chinese README](README.zh-CN.md) for details).

```bash
git clone https://github.com/xyzlily215-cmyk/fjsp-dispatch-system.git
cd fjsp-dispatch-system

python3.12 -m venv .venv && source .venv/bin/activate
python -m pip install -r algorithm-service/requirements.txt

cd web-vue && npm ci && npm run build && cd ..

cp .env.example .env
# edit .env: set your own FJSP_DB_PASSWORD
./scripts/start-demo.sh
```

Entry points:

- Web console: <http://127.0.0.1:8082/index.html?api=http://localhost:8081/api/v1>
- Business API: <http://localhost:8081/api/v1> · Algorithm health: <http://localhost:8101/health>
- AGH workbench (optional, `FJSP_START_AGH=1`, requires building the AGH CLI first): <http://localhost:4177/>

Demo accounts (local demo only, password `Fj@123456`): `dispatcher` / `reviewer` / `manager` / `admin`. Verification scripts (`reset-demo.sh`, `run-smoke-test.sh`, `run-e2e.sh`, `perf-baseline.sh`, `collect-evidence.sh`) and the AGH/MHS setup are documented in the [Chinese README](README.zh-CN.md) and [`agh-integration/README.md`](agh-integration/README.md).

> The AGH agent integration is optional and requires your own model API key (Agnes AI or any major provider) in `~/.config/fjsp/agnes.env` — no keys are shipped in this repository.

## Security & Privacy

- No secrets in the repo: `.env`, API keys and credentials are gitignored; copy `.env.example` and fill in local values. `scripts/check-env.sh` refuses example passwords and never prints secrets.
- Demo passwords are local-demo only; the `prod` profile refuses built-in demo passwords and requires `FJSP_SEED_ADMIN_PASSWORD` / `FJSP_JWT_SECRET` from the environment.
- If you ever committed a key by mistake, revoke it at the provider first, then rewrite history.

## Third-Party Credits & License

- [Agnes Harness (AGH)](https://github.com/AgnesAI-Labs/agnes-harness) — agent runtime (Apache-2.0), used as an external component, not vendored.
- Frameworks and libraries: Spring Boot, FastAPI, Vue 3, Element Plus, ECharts, PostgreSQL, and others — see `business-service/pom.xml`, `algorithm-service/requirements.txt` and `web-vue/package.json` for the full list and their respective licenses.
- The `multilingual-e5-small` embedding model used by the experience-retrieval RAG is downloaded separately (Hugging Face mirror) and not vendored.

This project is released under the [MIT License](LICENSE).
