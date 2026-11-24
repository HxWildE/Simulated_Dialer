# SmartDialer: Production-Grade Outbound Dialing Engine

SmartDialer is a zero-bloat, high-concurrency outbound debt collections dialing prototype built in **Go (1.22+)** and **PostgreSQL 16**. It solves outbound dialing by uniting high-throughput **Progressive** and **Predictive** pacing with a strict, non-bypassable **Safety Controller**.

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
docs/
  ARCHITECTURE.md           # Living architecture, ADRs, state machines, scale analysis
docker-compose.yml          # Postgres 16 + SmartDialer service + Simulator runner
Makefile                    # Build, test, run, and benchmark targets
```

---

## Quickstart

### 1. Prerequisites
- Go 1.22+
- PostgreSQL 16+ (or Docker)

### 2. Run All Tests
```bash
go test -v ./...
```

### 3. Run Simulator (Failures, Scenarios & Load Test)
```bash
# Run full simulation suite
go run cmd/simulator/main.go --all

# Or run specific test sections:
go run cmd/simulator/main.go --failures   # 5 Mandatory Failure Cases
go run cmd/simulator/main.go --scenarios  # Predictive Scenarios A, B, C, D
go run cmd/simulator/main.go --load       # 100 -> 1,000 Agent Concurrency Load Test
```

### 4. Run HTTP API Server
```bash
go run cmd/dialer/main.go
```

### 5. Run with Docker Compose
```bash
# Spin up PostgreSQL and SmartDialer service
docker compose up -d

# Run the simulation runner container
docker compose --profile sim run --rm simulator
```

---

## API Endpoints

- `GET /health` - Service health and carrier status
- `POST /api/agents` - Create or update an agent (`name`, `state`)
- `POST /api/borrowers` - Create a borrower debt lead (`phone_number`)
- `POST /api/campaigns/start` - Start dialer worker pool (`mode`: `PROGRESSIVE` or `PREDICTIVE`)
- `POST /api/campaigns/stop` - Stop dialer worker pool
- `POST /api/webhooks/{provider}` - Ingest asynchronous carrier events (`INITIATED`, `RINGING`, `ANSWERED`, `COMPLETED`, `FAILED`)
- `GET /api/metrics` - Real-time aggregate telemetry and worker stats
