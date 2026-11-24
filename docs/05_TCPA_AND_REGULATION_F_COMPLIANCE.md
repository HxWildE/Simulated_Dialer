# 05. TCPA & Regulation F Compliance Gate

## Executive Summary
This document outlines the regulatory compliance architecture of the **SmartDialer** platform. It details how the **ComplianceGate** prevents civil statutory violations under the **Telephone Consumer Protection Act (TCPA)** and the Consumer Financial Protection Bureau's **Regulation F (12 CFR § 1006.14)** using timezone-aware local calling windows, 7-in-7 frequency caps, and an in-memory Bloom filter Do-Not-Call (DNC) registry.

---

## 1. The Problem: Regulatory Liabilities in Collections Dialing

Collections outbound dialing is subject to stringent federal oversight with catastrophic penalties:

### 1.1 TCPA Timezone Calling Windows (47 U.S.C. § 227)
- **The Law**: Telemarketing and collections calls may only be placed between **8:00 AM and 9:00 PM local time at the called party's location**.
- **The Danger**: When dialing from a central server located in New York (EDT), placing a call at 9:00 AM EDT reaches a borrower in Los Angeles (PDT) at **6:00 AM**—a severe federal violation!
- **Statutory Penalties**: **\$500 to \$1,500 per call** under private right of action. Dialing 1,000 West Coast debtors 1 hour early results in an immediate \$1.5M class-action liability.

### 1.2 CFPB Regulation F (12 CFR § 1006.14)
- **Rule 1 (7-in-7 Frequency Cap)**: A debt collector is presumed to violate federal law if they place a telephone call to a person regarding a particular debt more than **7 times within a rolling 7-day period**.
- **Rule 2 (Conversation Wait Period)**: After having a telephone conversation with a debtor regarding a debt, the collector must not call again regarding that debt within **7 consecutive days**.

### 1.3 Do-Not-Call (DNC) Registry Scrubber
- Borrowers who submit formal cease-and-desist or DNC notices must be scrubbed instantly. Querying external databases synchronously for every single call adds 50–150ms of dial latency.

---

## 2. The Solution: Multi-Stage Compliance Gate

The `ComplianceGate` sits in front of the call reservation pipeline, vetting every debtor prior to trunk allocation:

```
                          Borrower Dial Candidate
                                     │
                                     ▼
                      Stage 1: DNC Bloom Filter Scrubber
                      ┌────────────────────────────────┐
                      │ O(1) Memory Bitset + Exact Map │
                      └────────────────────────────────┘
                                     │
                                (Clean / Not DNC)
                                     │
                                     ▼
                      Stage 2: TCPA Local Timezone Window
                      ┌────────────────────────────────┐
                      │ Convert UTC -> Borrower IANA   │
                      │ Assert: 08:00 <= Local < 21:00 │
                      └────────────────────────────────┘
                                     │
                                (In Window)
                                     │
                                     ▼
                      Stage 3: CFPB Regulation F Rules
                      ┌────────────────────────────────┐
                      │ Assert: Attempts in 7d < 7     │
                      │ Assert: Last Talk >= 7 days    │
                      └────────────────────────────────┘
                                     │
                                (Compliant)
                                     │
                                     ▼
                        [VERDICT: APPROVED TO DIAL]
```

### 2.1 TCPA Local Timezone Engine
Borrowers are stored with their IANA timezone identifier:
```sql
ALTER TABLE borrowers ADD COLUMN timezone TEXT NOT NULL DEFAULT 'America/New_York';
```
The compliance gate resolves the local time using Go's `time.LoadLocation`:
```go
loc, _ := time.LoadLocation(timezone)
localTime := now.In(loc)
hour := localTime.Hour()

if hour < 8 || hour >= 21 {
    return false, "TCPA violation: outside 08:00-21:00 local time window"
}
```

### 2.2 Regulation F Frequency Tracker
The database maintains real-time attempt tracking:
```sql
ALTER TABLE borrowers ADD COLUMN last_called_at TIMESTAMPTZ;
ALTER TABLE borrowers ADD COLUMN call_attempts_last_7_days INT NOT NULL DEFAULT 0;
```
When validated:
```go
if attemptsLast7Days >= 7 {
    return false, VerdictBlockedRegFWeeklyLimit, "Reg F violation: exceeded 7 calls in last 7 days"
}
if lastConnectedAt != nil && now.Sub(*lastConnectedAt) < 7*24*time.Hour {
    return false, VerdictBlockedRegFConversationWait, "Reg F violation: conversation occurred within past 7 days"
}
```

### 2.3 In-Memory DNC Bloom Filter with Exact Fallback
To achieve microsecond-latency scrubbing:
- A 64KB bitset evaluates 3 independent FNV-1a hash functions:
  $$h_i(s) = \text{FNV1a}(i \parallel s) \pmod M$$
- If all 3 bits are set, an exact in-memory hash set eliminates false positives.
- Clean numbers pass through with zero heap allocations and $O(1)$ performance.

---

## 3. Code Implementation Breakdown

- **Compliance Package**: `internal/compliance/tcpa.go`
  - `DNCBloomFilter`: In-memory Bloom filter with exact map fallback.
  - `IsCallingWindowAllowed(timezone, now)`: IANA timezone converter and TCPA hour checker.
  - `CheckRegulationF(attemptsLast7Days, lastConnectedAt, now)`: 7-in-7 and conversation wait validator.
  - `ComplianceGate.ValidateDial(...)`: Orchestrates DNC $\to$ TCPA $\to$ Reg F.
- **Verdicts Specification**:
  - `VerdictApproved`
  - `VerdictBlockedOutsideTCPAHours`
  - `VerdictBlockedRegFWeeklyLimit`
  - `VerdictBlockedRegFConversationWait`
  - `VerdictBlockedDNCRegistry`

---

## 4. Verification & Unit Tests

Implemented in `internal/compliance/tcpa_test.go`:
- `TestTCPATimezoneCallingWindow`:
  - 13:30 UTC: New York (09:30 AM) $\to$ `ALLOWED`; Los Angeles (06:30 AM) $\to$ `BLOCKED`.
  - 02:30 UTC: New York (10:30 PM) $\to$ `BLOCKED`; Los Angeles (07:30 PM) $\to$ `ALLOWED`.
- `TestRegulationF_FrequencyCap`:
  - 6 attempts in 7 days $\to$ `APPROVED`.
  - 7 attempts in 7 days $\to$ `BLOCKED_REG_F_WEEKLY_LIMIT`.
- `TestRegulationF_ConversationCooloff`:
  - Debtor conversation 3 days ago $\to$ `BLOCKED_REG_F_CONVERSATION_WAIT`.
  - Debtor conversation 8 days ago $\to$ `APPROVED`.
- `TestDNCBloomFilter_RegistrationAndLookup`: Asserts instant lookup of blacklisted numbers.
- `TestComplianceGate_UnifiedValidation`: Tests end-to-end multi-stage pipeline.
- **Result**: `PASS (2.20s)`.
