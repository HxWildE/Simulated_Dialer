# 03. Multi-Carrier Trunk Hedging & Dynamic Least-Cost Routing (LCR)

## Executive Summary
This document describes the telephony resilience and cost-optimization architecture of the **SmartDialer** platform. It details how the **CarrierRouter** dynamically balances commercial cost-per-minute rate cards via Least-Cost Routing (LCR), mitigates tail-latency timeouts using concurrent Trunk Hedging, and protects downstream infrastructure through per-carrier adaptive circuit breakers.

---

## 1. The Problem

### 1.1 Single-Carrier Dependency & Outage Impact
Collections dialers placing tens of thousands of calls daily cannot rely on a single telecom provider:
1. **Trunk Degradation & SIP 503s**: Telephony carriers frequently suffer temporary network congestion, packet loss, or routing faults. If the dialer is pinned to a single trunk, all calls fail simultaneously, dropping agent occupancy to zero.
2. **Setup Tail Latency (P99 > 3000ms)**: When a carrier's SIP signaling gateway is overloaded, call initiation stalls. Agents sit waiting while in-flight calls accumulate.
3. **Unoptimized Commercial Telecom Costs**: Telecom carriers offer wildly differing termination rate cards:
   - Tier 1 Premium Carriers (e.g., \$0.012/min): Highly reliable, low latency, but expensive.
   - Discount Wholesale Trunks (e.g., \$0.006/min): 50% cheaper, but prone to higher jitter and periodic drops.
   *Dialing exclusively on Tier 1 doubles telephony expense; dialing exclusively on discount trunks compromises SLA.*

---

## 2. The Solution

### 2.1 Least-Cost Routing (LCR) with Circuit Breaker Integration
The `CarrierRouter` maintains a real-time registry of all connected telephony trunks:

```
                            Call Placement Request
                                       │
                                       ▼
                         Select Lowest-Cost Healthy Trunk
                         ┌─────────────────────────────┐
                         │ Filter: Circuit != 'OPEN'   │
                         │ Sort: CostPerMin ASC, Pri   │
                         └─────────────────────────────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
                 Discount Trunk A              Tier 1 Trunk B
                 Cost: 0.6¢ / min              Cost: 1.2¢ / min
                 State: CLOSED                 State: CLOSED
                 [Selected Primary]            [Selected Backup]
```

#### Routing Algorithm:
1. Inspects the state of each carrier (`CLOSED`, `HALF-OPEN`, `OPEN`).
2. If an `OPEN` carrier has exceeded its cooldown period (default: 10s), it transitions to `HALF-OPEN` to admit a canary test call.
3. Healthy candidate carriers are sorted by `CostPerMinuteCents ASC`, selecting the lowest-cost option as the primary carrier.

### 2.2 Trunk Hedging Architecture
Inspired by Google's "The Tail at Scale" (Dean & Barroso), trunk hedging eliminates tail latencies without doubling call volume:

```
t = 0ms     Primary Trunk Dispatched (Discount Carrier)
             │
t = 1200ms  Hedge Deadline Expires (No ACK from Primary yet)
             ├──► Secondary Trunk Dispatched (Tier 1 Carrier)
             │
t = 1350ms  Secondary Trunk Answers! (Winner)
             └──► Bridge Call to Agent; Primary result safely canceled
```

1. **Primary Dispatch**: The dialer issues `PlaceCall` to the LCR carrier.
2. **Hedge Timer**: A timer starts (default: `1200ms`).
3. **Concurrent Backup Dispatch**:
   - If the primary carrier returns an immediate error (e.g. SIP 503), the router dispatches the secondary trunk immediately.
   - If the hedge timer fires before the primary responds, the secondary trunk is dispatched in parallel.
4. **First-Completion Wins**: Whichever carrier returns a valid `provider_call_id` first is bridged to the agent; the slower call attempt is safely disregarded.

### 2.3 Adaptive Per-Trunk Circuit Breakers
Each trunk tracks its consecutive errors independently:
- **Trip to OPEN**: 4 consecutive errors trip the carrier to `CircuitOpen`, shielding the dialer from dialing into a dead trunk.
- **Cooldown to HALF-OPEN**: After 10 seconds of cooldown, the circuit transitions to `CircuitHalfOpen`.
- **Canary Probe**: If the canary call succeeds, consecutive errors are reset and the circuit returns to `CircuitClosed`. If it fails, the carrier trips back to `CircuitOpen`.

---

## 3. Code Implementation Breakdown

- **Router Implementation**: `internal/provider/router.go`
  - `CarrierRoute`: Wraps `TelecomProvider` with `CostPerMinuteCents`, `CircuitState`, `ConsecutiveErrors`, `P95LatencyMs`.
  - `SelectLCRCarrier()`: Selects the cheapest healthy trunk.
  - `PlaceCallWithHedging(ctx, callID, phoneNumber)`: Orchestrates primary dispatch, hedge timer, secondary dispatch, and channel racing.
  - `RegisterWebhookHandler(handler)`: Multiplexes inbound webhooks across all underlying trunks.
  - `CarrierHealthSummary()`: Exposes structured JSON metrics for operational dashboards.

---

## 4. Verification & Unit Tests

Implemented in `internal/provider/router_test.go`:
- `TestCarrierRouter_LCRSelection`: Asserts that when both Tier 1 (1.2¢) and Discount (0.6¢) are healthy, LCR picks Discount.
- `TestCarrierRouter_FailoverOnCircuitBreaker`: Simulates outage on Discount; asserts that after 4 errors, the circuit trips to `OPEN` and LCR automatically fails over to Tier 1.
- `TestCarrierRouter_HedgingSuccessOnPrimaryFailure`: Primary fails immediately; asserts hedged secondary succeeds cleanly within milliseconds.
- `TestCarrierRouter_AllCarriersDown`: Asserts proper error propagation when all registered trunks are down.
- **Test Result**: `PASS (3.10s)`.
