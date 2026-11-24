# SmartDialer: Production-Grade Outbound Dialing Engine

SmartDialer is a zero-bloat, high-concurrency outbound debt collections dialing prototype built in **Go (1.22+)**, **PostgreSQL 16**, and a **React + TypeScript + Tailwind CSS (Vite)** operations dashboard. It solves outbound dialing by uniting high-throughput **Progressive** and **Predictive** pacing with a strict, non-bypassable **Safety Controller**.

---

## Architecture Highlights

1. **Strict Architectural Pipeline:**
   ```
   Campaign -> Pacing Engine -> Safety Controller -> Call Allocator -> Telecom Provider
   ```
   Enforced in code via Go interfaces. The Pacing Engine can never directly dial or allocate resources.
2. **Dual Dialing Modes:**
   - **Progressive Dialing:** Dial only when agents are available ($N = \max(0, A - C_{\text{inflight}})$). Zero regulatory abandonment risk.
   - **Predictive Dialing:** Little's Law statistical engine with Erlang-inspired completion buffers that over-dials based on rolling answer rates and average talk times to maximize agent utilization.
3. **Non-Bypassable Safety Controller:**
   - **Sudden Drop Guard:** Rejects predictive dialing bursts if available agent count drops by $>20\%$ within 5 seconds.
   - **Abandonment Guard:** Forces instant fallback to Progressive mode if rolling abandonment exceeds 2.0% or provider error rate exceeds 25%.
   - **Capacity Cap:** Restricts ringing calls so anticipated answers cannot exceed $1.15 \times$ available agent capacity.
4. **PostgreSQL 16 as Single Source of Truth:**
   - Zero split-brain issues (no Kafka, Redis, or microservices bloat).
   - Atomic multi-resource locking using `SELECT ... FOR UPDATE SKIP LOCKED`.
   - Event idempotency via unique provider event IDs in `call_events`.
   - Monotonic state rankings (`CallStateRank`) ensuring out-of-order telecom webhooks never regress call state.
5. **Stale-State Reaper:**
   - Detects stuck calls from crashed workers or dropped carrier webhooks (>10s reserved, >5s answered without connected).
   - Safely rolls back agent states and reschedules borrowers with exponential backoff.
6. **Operational Dark-Mode Dashboard (`/web`):**
   - **Tab 1: Live Operations & Safety Monitor:** Real-time agent state grid (AVAILABLE, RESERVED, DIALING, CONNECTED, WRAP_UP, PAUSED, OFFLINE), circuit breaker status (CLOSED, OPEN, HALF-OPEN), pipeline visualizer, and live feed of Safety Controller decisions with reasons.
   - **Tab 2: Efficiency & Simulation Results Panel:** One-click scenario triggers (A, B, C, D), Progressive vs. Predictive side-by-side comparison table, and Scenario D dynamic shock timeline visualizer (70% &rarr; 10% drop with automatic safety fallback).
   - **Tab 3: Failure Cases & Load Test Verification:** Status cards for all 5 Failure Cases (with event trace logs) and concurrency load test metrics (100 &rarr; 1,000 workers, 0 double allocations, p50 / p95 / p99 reservation latency).

---

## Directory Structure
```
cmd/
  dialer/main.go            # Dialer REST API server + Worker pool + Graceful shutdown
  simulator/main.go         # Simulator for failure scenarios and predictive benchmarks
internal/
  domain/                   # Entities, explicit Agent & Call state machines, monotonic guards
  store/                    # PostgreSQL migrations, pgxpool, atomic reservations, idempotency
  pacing/                   # Progressive Engine + Predictive Statistical Little's Law Engine
  safety/                   # Non-bypassable Safety Controller
  allocator/                # Atomic agent & borrower reservation + carrier dispatch
  provider/                 # TelecomProvider interface + MockProviderA + MockProviderB
  worker/                   # Distributed worker loop + stale-state reaper / recovery
  tests/                    # Automated integration tests for the 5 Failure Cases
web/                        # React + TypeScript + Tailwind CSS (Vite) operational dashboard
docs/
  ARCHITECTURE.md           # Living architecture, ADRs, state machines, scale analysis
docker-compose.yml          # PostgreSQL 16 + Backend + Frontend
Makefile                    # make up, make test, make sim, make loadtest
```

---

## Quickstart

### 1. Run via Docker Compose (One-Command Setup)
```bash
make up
# or
docker compose up -d
```
Access points:
- **Frontend Dashboard:** http://localhost:3000 (or http://localhost:5173 during local dev)
- **Backend API & Health:** http://localhost:8080/health
- **PostgreSQL 16:** localhost:5432

### 2. Run All Automated Tests
```bash
make test
# or
go test -v ./...
```

### 3. Run Full Simulation Suite (Scenarios A–D + Failure Cases 1–5 + Load Test)
```bash
make sim
# or
go run cmd/simulator/main.go --all
```
This generates `simulation_results.json` and updates both backend and frontend reporting.

### 4. Run Concurrency Load Test (100 -> 1,000 Agents)
```bash
make loadtest
# or
go run cmd/simulator/main.go --load
```

### 5. Run Frontend Development Server
```bash
cd web
npm install
npm run dev
```

---

## API Endpoints (`/api/v1`)

- `GET /health` - Service health and carrier status
- `GET /api/v1/metrics/live` - Real-time agent state grid, active calls, telemetry, circuit breaker state, and safety decisions feed
- `POST /api/v1/simulator/run` - Trigger simulation runs from UI (`target`: `all`, `scenarios`, `failures`, `load`)
- `GET /api/v1/simulator/results` - Fetch structured `simulation_results.json`
- `POST /api/agents` - Create or update an agent (`name`, `state`)
- `POST /api/borrowers` - Create a borrower debt lead (`phone_number`)
- `POST /api/campaigns/start` - Start dialer worker pool (`mode`: `PROGRESSIVE` or `PREDICTIVE`)
- `POST /api/campaigns/stop` - Stop dialer worker pool
- `POST /api/webhooks/{provider}` - Ingest asynchronous carrier events (`INITIATED`, `RINGING`, `ANSWERED`, `COMPLETED`, `FAILED`)
