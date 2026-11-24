# 01. Components & Data Flow: Who Does What?

Is chapter me hum system ke har ek purze (component) ko alag-alag khol kar dekhenge:
- Kaun kisko call karta hai?
- Kya input aata hai aur kya output nikalta hai?
- Kis step par kaunsi approval milti hai?
- Agar koi fail ho jaye toh control kahan jata hai?

---

## 1. The High-Level Pipeline (Bird's Eye View)

```
[ Campaign Config ]
        │
        ▼
 ┌──────────────┐      "Hum kitni calls dial kar sakte hain?"
 │ Pacing Engine│ ──────────────────────────────────────────────┐
 └──────────────┘                                               ▼
        │ (Proposed: N calls)                          ┌─────────────────┐
        ▼                                              │Safety Controller│
 ┌───────────────────────────────────────────────────► │ (The Gatekeeper)│
 │                                                     └─────────────────┘
 │                                                              │
 │                                                              │ (Approved: M calls, M <= N)
 │                                                              ▼
 │                                                     ┌─────────────────┐
 │                                                     │ Call Allocator  │
 │                                                     │ (DB Atomicity)  │
 │                                                     └─────────────────┘
 │                                                              │
 │                                                              │ Locks Pending Calls + Agents
 │                                                              ▼
 │                                                     ┌─────────────────┐
 │                                                     │ Telecom Provider│
 │                                                     │ (Mock A / B)    │
 │                                                     └─────────────────┘
 │                                                              │
 │                                                              │ Webhook / Event
 │                                                              ▼
 └────────────────────── Telemetry Updates ◄─────────── [ Customer Answered! ]
```

---

## 2. Component-by-Component Deep Dive

### 1. Pacing Engine (`internal/pacing/`)
* **Role:** The Calculator (Dimag).
* **Responsibility:** Yeh har dial cycle (e.g., har 1 second me) math run karta hai.
* **Input Data:**
  - `A_avail`: Kitne agents abhi `AVAILABLE` hain?
  - `A_busy`: Kitne agents abhi call pe baat kar rahe hain?
  - `C_inflight`: Kitni calls abhi ring ho rahi hain telecom me?
  - `W_ring`: Average ring duration (e.g., 15 seconds).
  - `W_call`: Average call handle time (e.g., 60 seconds).
  - `p_ans`: Customer pickup probability (e.g., 30%).
* **Output:** Ek number: `N_target` (e.g., "Mera calculation keh raha hai ki 5 calls dial karo").
* **Key Detail:** Pacing engine ke paas dial karne ki authority **nahi** hoti! Wo sirf ek proposal deta hai.

---

### 2. Safety Controller (`internal/safety/controller.go`)
* **Role:** The Supreme Court / Air Traffic Inspector (Suraksha Kavach).
* **Responsibility:** Pacing engine jo bhi number de, Safety Controller usko **audit** karta hai. Agar system me koi bhi khatra hai, yeh us number ko reduce ya **0** (dialing freeze) kar deta hai.
* **The 4 Non-Bypassable Checks:**
  1. **Sudden Drop Guard:** Agar answer rate achaanak 50% gir gaya, toh dial band karo!
  2. **Abandonment Guard:** Agar abandonment rate 2.5% se upar gaya, predictive pacing ko turant kill karke strictly safe `Progressive Mode` me switch karo.
  3. **Provider Error Guard:** Agar telecom carrier 10% se zyada 500 error ya timeouts de raha hai, dial freeze karo taaki leads waste na ho.
  4. **Capacity Cap:** Ek safe hard ceiling (e.g., `MaxInflightRatio = 3.0x agents`).
* **Input:** Proposed $N$, Campaign state, Rolling metrics (window of 100 calls).
* **Output:** Final Approved $N_{\text{safe}}$. Agar khatra hai, toh reason code: `SAFETY_DROP_TRIPPED`, `SAFETY_ABANDON_LIMIT`, etc.

---

### 3. Call Allocator (`internal/allocator/allocator.go`)
* **Role:** The Locksmith (Kanoon ka rakhwala).
* **Responsibility:** Database me se safe tarike se leads aur agents ko pick karke unka pair banana.
* **The Golden Invariant (Subse Zaroori Niyam):**
  > **"Koi bhi 2 threads/workers ek hi agent ko ek sath book nahi kar sakte."**
  > **"Koi bhi lead do baar dial nahi ho sakti."**
* **How it works:**
  PostgreSQL ka atomic locking feature use karta hai:
  ```sql
  SELECT id, status FROM agents 
  WHERE status = 'AVAILABLE' 
  ORDER BY last_assigned_at ASC 
  LIMIT 1 
  FOR UPDATE SKIP LOCKED;
  ```
  - `FOR UPDATE`: Row par exclusive lock lagata hai.
  - `SKIP LOCKED`: Agar koi doosra worker kisi agent ko lock kar chuka hai, toh yeh wait karke deadlock nahi banata, balki agle free agent pe jump kar jata hai.
* **Input:** Final approved $N_{\text{safe}}$.
* **Output:** Atomic Reservation: Lead status banta hai `RESERVED`, Agent status banta hai `RESERVED`.

---

### 4. Telecom Providers & Smart Router (`internal/provider/`)
* **Role:** The Carrier Interface (Telecom Pipe).
* **Responsibility:** Asli duniya ke telecom networks (Twilio, Tata, Airtel, Bandwidth) se baat karna.
* **Mock Providers:**
  - `MockProviderA`: Ideal provider (fast, 50ms latency, zero drop, clean SIP status).
  - `MockProviderB`: Real-world flaky provider (3000ms delay, packet loss, duplicate webhooks, out-of-order events).
* **Smart Carrier Router (Enterprise Feature):**
  - **Least-Cost Routing (LCR):** Pehle saste provider ko call bhejo.
  - **Hedged Requests:** Agar Provider A 2500ms tak जवाब nahi deta, toh background me Provider B ko parallel synthetic call maar do. Jo pehle pick karega wo jeetega, doosra cancel ho jayega.
  - **Circuit Breaker:** Agar kisi carrier pe consecutive 5 errors aate hain, us carrier ko 30 seconds ke liye `OPEN` (blacklist) kar diya jata hai.

---

### 5. Ghost Call Reaper (`internal/worker/reaper.go`)
* **Role:** The Janitor (Safai Karamchari).
* **Problem it solves:**
  Socho humne Telecom ko call karne ko bola. Customer ka phone ring hua. Lekin raste me telecom tower gir gaya ya internet cut gaya. Na "Answered" ka webhook aaya, na "Failed" ka webhook aaya!
  - Lead database me `INITIATED` banke hamesha ke liye atak jayegi.
  - Agent hamesha ke liye `DIALING` banke fas jayega.
* **Reaper Solution:**
  - Reaper har 5 second me background me ghoomta hai.
  - Query: *"Aisi kaunsi calls hain jo pichle 30 seconds se `RINGING` ya `INITIATED` me hain aur koi update nahi aaya?"*
  - Unko turant **CANCELLED / TIMED_OUT** mark karta hai aur unse jude agent ko wapas **AVAILABLE** kar deta hai taaki agent fas na jaye!

---

### 6. Single Source of Truth: PostgreSQL Store (`internal/store/`)
* **Role:** The Vault.
* **Why not Redis or Kafka for state?**
  - Redis in-memory hota hai, network partition me split-brain ho sakta hai.
  - Kafka pub-sub queue hai, usme row-level update aur ACID guarantees nahi milti.
  - **PostgreSQL 16** ACID compliance deta hai: Agar server crush bhi ho jaye, koi bhi agent double-book nahi ho sakta aur financial fines se bacha ja sakta hai.

---

## 3. Data Flow Diagram: From Dial to Conversation

Yeh sequence chart dikhata hai ki actual packets aur state transitions kaise travel karte hain:

```mermaid
sequenceDiagram
    autonumber
    participant PE as Pacing Engine
    participant SC as Safety Controller
    participant AL as Call Allocator
    participant DB as Postgres DB
    participant TP as Telecom Provider
    participant C as Customer Phone
    participant AG as Human Agent

    PE->>SC: Propose N=5 Calls (Little's Law)
    SC->>SC: Run 4 Safety Guards (Abandonment, Drop, Provider Error, Cap)
    SC->>AL: Approved M=3 Calls
    AL->>DB: BEGIN TX; SELECT ... FOR UPDATE SKIP LOCKED
    DB-->>AL: Locks Lead #101 & Agent #1
    AL->>DB: Lead -> INITIATED, Agent -> DIALING; COMMIT TX
    AL->>TP: InitiateCall(Lead #101)
    TP->>C: SIP INVITE (Ringing...)
    TP-->>AL: Webhook: Call RINGING
    C-->>TP: Customer Picks Up ("Hello?")
    TP-->>AL: Webhook: Call ANSWERED
    alt Agent is still Available
        AL->>DB: Update Call -> CONNECTED, Agent -> CONNECTED
        AL->>AG: Media Bridge established! (Agent talks to Customer)
    else Agent got disconnected or delayed > 2s
        AL->>DB: Call -> ABANDONED, Play Disclosure Audio, Hang Up
        SC->>SC: Trip Abandonment Spike Counter!
    end
```
