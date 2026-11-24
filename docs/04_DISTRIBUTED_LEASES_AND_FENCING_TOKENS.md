# 04. Distributed Leases with Monotonic Fencing Tokens

## Executive Summary
This document addresses the **Split-Brain Zombie Worker Problem** in distributed dialer architectures. It outlines how **SmartDialer** eliminates double-allocations and corrupted state transitions using **Monotonic Fencing Tokens** embedded in atomic PostgreSQL transactions.

---

## 1. The Problem: The Zombie Worker Split-Brain

In distributed systems, workers experience Garbage Collection (GC) pauses, network delays, or CPU throttling. Without monotonic fencing, these pauses cause severe data corruption:

```
Worker 1 (Stalled)                     Crash Reaper                     Worker 2 (New)
      │                                     │                                 │
1. Reserves Agent A                         │                                 │
   (Call #101)                              │                                 │
      │                                     │                                 │
2. [Long GC Pause / Network Stall]          │                                 │
      │                                     │                                 │
      │                             3. Lease Expires!                         │
      │                                Reclaims Call #101                     │
      │                                Resets Agent A to AVAILABLE             │
      │                                     │                                 │
      │                                     │                           4. Reserves Agent A
      │                                     │                              (Call #102)
      │                                     │                                 │
5. Worker 1 Wakes Up!                       │                                 │
   Sends: "Call #101 is ANSWERED"           │                                 │
      │                                     │                                 │
      ▼                                     ▼                                 ▼
   ❌ WITHOUT FENCING: Worker 1 overwrites Agent A's state to CONNECTED (Call #101),
      while Worker 2 simultaneously connects Call #102!
      Result: TWO BORROWERS BRIDGED TO THE SAME AGENT (Split-Brain Catastrophe).
```

---

## 2. The Solution: Monotonic Fencing Tokens

We implemented the **Fencing Token** pattern (Martin Kleppmann, *Designing Data-Intensive Applications*):

```
                        Database State: lease_token = 1
                                       │
        Worker 1 Reserves ─────────────┴─────────────► Receives Token = 2
                                                             │
                    [Worker 1 Suspended by GC]                │
                                                             │
        Crash Reaper Reclaims ────────────────────────► Increments Token = 3
                                                             │
        Worker 2 Reserves ────────────────────────────► Receives Token = 4
                                                             │
        Worker 1 Wakes Up:                                   │
        Attempts UPDATE with Token = 2                       │
                                                             │
                                   ┌─────────────────────────┴────────┐
                                   │ Database Check:                  │
                                   │ Is Token 2 == Current Token (4)? │
                                   └──────────────────────────────────┘
                                                    │
                                                   NO!
                                                    │
                                                    ▼
                                     [ErrStaleFencingToken]
                                      ABORT TRANSACTION!
```

### 2.1 Database Schema
Every agent and call record carries a monotonic `lease_token BIGINT`:
```sql
ALTER TABLE agents ADD COLUMN lease_token BIGINT NOT NULL DEFAULT 1;
ALTER TABLE calls ADD COLUMN lease_token BIGINT NOT NULL DEFAULT 1;
```

### 2.2 Atomic Token Increment on Reservation
When reserving an agent, PostgreSQL increments and returns the new token:
```sql
UPDATE agents
SET state = 'RESERVED',
    current_call_id = $1,
    updated_at = NOW(),
    version = version + 1,
    lease_token = lease_token + 1
WHERE id = $2
RETURNING lease_token;
```
The resulting `lease_token` is written to `calls.lease_token`.

### 2.3 Reaper Invalidation
When the `CrashReaper` reclaims a stuck or timed-out call, it increments the token on both the call and the agent:
```sql
-- 1. Mark call FAILED and increment token
UPDATE calls
SET state = 'FAILED', updated_at = NOW(), lease_token = lease_token + 1
WHERE id = $1;

-- 2. Release Agent and increment token
UPDATE agents
SET state = 'AVAILABLE', current_call_id = NULL, updated_at = NOW(), version = version + 1, lease_token = lease_token + 1
WHERE id = $1;
```

### 2.4 Fenced State Mutation
Any subsequent webhook or worker state transition enforces strict equality:
```go
if expectedLeaseToken > 0 && call.LeaseToken != expectedLeaseToken {
    return ErrStaleFencingToken
}

tag, err := tx.Exec(ctx, `
    UPDATE calls
    SET state = $1, updated_at = NOW()
    WHERE id = $2 AND lease_token = $3;
`, nextState, call.ID, expectedLeaseToken)

if tag.RowsAffected() == 0 {
    return ErrStaleFencingToken
}
```

---

## 3. Code Implementation Breakdown

- **Domain Entities**: `internal/domain/entities.go`
  - Added `LeaseToken int64` to `Agent` and `Call`.
- **Database Store**: `internal/store/postgres.go`
  - `ReserveAgentAndBorrowerSharded`: Atomically increments and propagates `lease_token`.
  - `ProcessProviderEventWithFencing`: Rejects updates where `expectedLeaseToken != call.LeaseToken`.
  - `RecoverStuckCall`: Bumps `lease_token` on both `calls` and `agents`.
- **Error Definition**: `internal/store/store.go`
  - `ErrStaleFencingToken = errors.New("stale fencing token: call was reclaimed or reassigned")`.

---

## 4. Verification & Unit Tests

Implemented in `internal/store/sharded_test.go`:
- `TestPostgresStore_FencingToken_PreventsSplitBrain`:
  1. Worker reserves Agent A with `lease_token = 2`.
  2. Crash Reaper reclaims the call, bumping token to `3`.
  3. Zombie worker attempts to push `ANSWERED` event with `lease_token = 2`.
  4. Store detects token mismatch and rejects the write.
- `TestPostgresStore_FencingToken_StaleTokenRejected`:
  - Explicitly tests passing `lease_token - 1` against an active call.
  - Asserts exact error return: `store.ErrStaleFencingToken`.
- **Result**: `PASS` (100% split-brain immunity verified).
