# 06. Observability: OpenTelemetry Distributed Tracing & Chaos Engineering Test Harness

## Executive Summary
This document details the observability and resilience verification architecture of the **SmartDialer** platform. It covers our zero-dependency **OpenTelemetry W3C Distributed Tracing** implementation and the **Chaos Engineering Fault Injection** harness used to validate system recovery under adverse network, database, and carrier conditions.

---

## 1. The Problem

### 1.1 The Distributed Telephony Debugging Nightmare
An outbound call passes through multiple asynchronous stages:
$$\text{Campaign} \longrightarrow \text{Pacing Engine} \longrightarrow \text{Safety Controller} \longrightarrow \text{Worker Pool} \longrightarrow \text{Telecom Carrier} \longrightarrow \text{Webhook Event} \longrightarrow \text{Agent Connect}$$

Without distributed tracing:
- If a borrower hears dead air, engineers cannot trace which pacing cycle initiated the call, which telecom provider handled the signaling, or why the carrier webhook arrived out of order.
- Correlating asynchronous webhooks with worker thread IDs across millions of log lines is virtually impossible.

### 1.2 "Production-Only" Distributed Edge Cases
Telephony and cloud infrastructures exhibit chaotic edge cases:
1. **Network Jitter & Jitter Bursts**: Carrier SIP gateways intermittently delay responses by 500–2,000ms.
2. **SIP 503 Carrier Drops**: Upstream trunk outages reject 10–20% of calls.
3. **Worker Goroutine Crashes**: Unexpected panics (e.g., OOM or nil pointer dereference) leave agents and calls orphaned in `RESERVED` or `INITIATED` state.

---

## 2. The Solution

### 2.1 OpenTelemetry W3C Distributed Tracing
We implemented a zero-bloat, standard-compliant OpenTelemetry tracing package conforming to the **W3C Trace Context specification**:
$$\text{traceparent} = \text{00}-\underbrace{\text{4bf92f3577b34da6a3ce929d0e0e4736}}_{\text{32-hex Trace ID}}-\underbrace{\text{00f067aa0ba902b7}}_{\text{16-hex Span ID}}-\text{01}$$

```
Root Span: [pacing_cycle] (TraceID: 4bf92f35...)
   │
   ├── Child Span: [safety_evaluation]
   │      Attributes: {proposed_calls: 15, approved_calls: 12, decision: "APPROVE"}
   │
   ├── Child Span: [call_reservation]
   │      Attributes: {agent_id: "...", borrower_id: "...", lease_token: 3}
   │
   └── Child Span: [telecom_dispatch] (Traceparent injected into SIP headers)
          │
          ▼
   Async Inbound Webhook (Traceparent extracted from payload)
   └── Child Span: [carrier_webhook_inbound]
          Attributes: {event_type: "ANSWERED", provider: "MockProviderA"}
```

#### Key Capabilities:
- **Parent-Child Span Propagation**: Child spans inherit the root `TraceID` and point to their `ParentID`.
- **W3C Header Extraction**: `ExtractTraceparent(ctx, header)` parses incoming headers from carrier webhooks into standard Go `context.Context`.
- **Span Attributes**: Rich key-value contextual metadata (`call.id`, `provider.name`, `lease_token`).

### 2.2 Chaos Engineering Fault Injector
The `ChaosInjector` allows injecting real-world faults during development and automated integration testing:

```go
type FaultProfile struct {
    CarrierDropRate    float64 // E.g., 0.10 (10% simulated SIP 503s)
    MaxNetworkJitterMs int     // E.g., 300ms of random latency
    DatabaseStallRate  float64 // E.g., 0.05 simulated query stalls
    WorkerPanicRate    float64 // E.g., 0.02 simulated worker crashes
}
```

#### Injected Fault Types:
1. `InjectNetworkJitter(ctx)`: Introduces uniform random latency ($0 \dots \text{MaxNetworkJitterMs}$) to verify hedge timers and async timeout handling.
2. `MaybeInjectCarrierDrop()`: Returns `ErrInjectedCarrierDrop` to test carrier circuit breaker trips and failover to secondary trunks.
3. `MaybeInjectWorkerPanic()`: Triggers a simulated goroutine panic to ensure that the `CrashReaper` detects expired leases, transitions calls to `FAILED`, and releases agents with incremented fencing tokens.

---

## 3. Code Implementation Breakdown

- **Tracing Implementation**: `internal/telemetry/otel.go`
  - `NewTraceID()`: 16-byte cryptographically secure random hex string.
  - `NewSpanID()`: 8-byte random hex string.
  - `StartSpan(ctx, name)`: Spawns root or child span adhering to W3C format.
  - `Span.Traceparent()`: Outputs `00-{trace_id}-{span_id}-01`.
  - `ExtractTraceparent(ctx, header)`: Decodes incoming W3C header into context.
- **Chaos Implementation**: `internal/chaos/chaos.go`
  - `ChaosInjector`: Thread-safe fault injection engine with dynamic enable/disable controls.
  - `MaybeInjectCarrierDrop()`
  - `InjectNetworkJitter(ctx)`
  - `MaybeInjectWorkerPanic()`

---

## 4. Verification & Unit Tests

- **OpenTelemetry Tests (`internal/telemetry/otel_test.go`)**:
  - `TestOpenTelemetry_SpanLifecycle`: Verifies trace ID inheritance, span ID parentage, and W3C traceparent formatting.
  - `TestOpenTelemetry_W3CTraceparentExtraction`: Validates decoding of standard W3C headers and rejection of malformed headers.
- **Chaos Tests (`internal/chaos/chaos_test.go`)**:
  - `TestChaosInjector_CarrierDropRate`: Verifies 100% vs 0% failure injection and toggle control.
  - `TestChaosInjector_NetworkJitter`: Asserts network delay within configured bounds.
  - `TestChaosInjector_WorkerPanic`: Confirms simulated panic invocation under test harnesses.
- **Result**: `PASS (2.80s)`.
