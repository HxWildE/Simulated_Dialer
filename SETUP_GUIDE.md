# SmartDialer: Complete Setup & Run Guide (Step-by-Step)

Yeh guide ek naye user ke liye aur aapke current system (Windows, native PostgreSQL / Docker) ke liye complete setup aur run instructions provide karti hai.

---

## 📌 Table of Contents
1. [System Prerequisites (Kya-kya installed hona chahiye)](#1-system-prerequisites)
2. [Method 1: Local Native Setup (Recommended for Your System)](#2-method-1-local-native-setup-for-your-system)
   - Step 1: Database Setup (PostgreSQL)
   - Step 2: Backend Server Run Karna
   - Step 3: Frontend Dashboard Run Karna
   - Step 4: Simulations & Benchmarks Run Karna
3. [Method 2: One-Click Docker Setup (For Any New User)](#3-method-2-one-click-docker-setup-for-any-new-user)
4. [Running Tests & Verifications](#4-running-tests--verifications)
5. [Common Troubleshooting & FAQs](#5-common-troubleshooting--faqs)

---

## 1. System Prerequisites

Kisi bhi system pe run karne ke liye minimum requirements:
- **Go**: 1.22 ya higher (`go version` check karein)
- **Node.js**: v18 ya higher + npm (`node -v`, `npm -v`)
- **PostgreSQL**: Version 15 ya 16+ (Local service ya Docker)
- **Git**: Installed
- *(Optional)* **Docker Desktop**: Agar bina local DB ke container me chalana ho.

---

## 2. Method 1: Local Native Setup (For Your System)

Aapke Windows machine par PostgreSQL natively `localhost:5432` par running hai.

### Step 1: PostgreSQL Database Verify / Create
Agar database create nahi hua hai, to PowerShell me run karein:

```powershell
# Default postgres user se database create karein
psql -U postgres -c "CREATE DATABASE smartdialer;"
```
*(Password prompt aaye toh apna postgres password daalein, default: `postgres`)*

---

### Step 2: Go Backend Run Karna (Terminal 1)

Naya terminal (PowerShell) kholein aur project root directory me jayein:

```powershell
# 1. Project directory me confirm karein
cd c:\Users\harsh\OneDrive\Documents\Desktop\finalProject

# 2. Database connection string set karein (agar default se different ho)
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/smartdialer?sslmode=disable"

# 3. Backend API server aur worker pool start karein
go run cmd/dialer/main.go
```

**Terminal me yeh output dikhega:**
```text
INFO database migrations applied successfully
INFO starting dialer API server port=8080
INFO starting stale-state reaper interval=2s
```

✅ **Backend Verification URLs:**
- **Health Check**: [http://localhost:8080/health](http://localhost:8080/health)
- **Live Metrics JSON**: [http://localhost:8080/api/v1/metrics/live](http://localhost:8080/api/v1/metrics/live)

---

### Step 3: React + Vite Frontend Dashboard Run Karna (Terminal 2)

Ek aur naya terminal (PowerShell) kholein:

```powershell
# 1. Web folder me jayein
cd c:\Users\harsh\OneDrive\Documents\Desktop\finalProject\web

# 2. Dependencies install karein (sirf pehli baar)
npm install

# 3. Development server start karein
npm run dev
```

**Terminal output:**
```text
  VITE v5.4.21  ready in 450 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
```

✅ **Browser me open karein:**
👉 **[http://localhost:5173](http://localhost:5173)**

Yahan aapko live 3 tabs dikhenge:
1. **Live Operations & Safety Monitor**: Real-time agent state pills (`AVAILABLE`, `RESERVED`, `DIALING`, `CONNECTED`, etc.), active calls, carrier status, aur Safety Controller live decisions feed.
2. **Efficiency & Simulation Results**: Scenarios A, B, C, D comparison table (Progressive vs. Predictive) aur Scenario D dynamic answer rate drop timeline.
3. **Failure Cases & Load Test**: 5 mandatory distributed failure tests aur 100-1,000 worker concurrency benchmark results.

---

### Step 4: Simulations & Benchmarks Run Karna (Terminal 3)

Agar aapko simulation metrics regenerate karne hain ya UI par one-click trigger dekhna hai:

```powershell
cd c:\Users\harsh\OneDrive\Documents\Desktop\finalProject

# Option A: Sab kuch run karein (Scenarios A-D + Failures 1-5 + Load Test)
go run cmd/simulator/main.go --all

# Option B: Sirf 4 Scenarios compare karein (A, B, C, D)
go run cmd/simulator/main.go --scenarios

# Option C: Sirf 5 Failure Cases test karein
go run cmd/simulator/main.go --failures

# Option D: Sirf 100 -> 1,000 Concurrency Load Test run karein
go run cmd/simulator/main.go --load
```

---

## 3. Method 2: One-Click Docker Setup (For Any New User)

Agar kisi naye user ke paas local PostgreSQL ya Go setup nahi hai, aur unke paas **Docker Desktop** installed aur running hai:

```powershell
# 1. Project root me jayein
cd c:\Users\harsh\OneDrive\Documents\Desktop\finalProject

# 2. Sabhi containers build aur start karein
docker compose up -d --build
```

Docker automatically spin up karega:
- `smartdialer-postgres`: PostgreSQL 16 container on port `5432`
- `smartdialer-backend`: Go REST API + Worker daemon on port `8080`
- `smartdialer-frontend`: React dashboard on port `3000`

**Access Points:**
- **Frontend Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Backend API**: [http://localhost:8080/health](http://localhost:8080/health)

Containers stop karne ke liye:
```powershell
docker compose down
```

---

## 4. Running Tests & Verifications

Pura backend test suite run karne ke liye (11 packages, 100% pass):

```powershell
cd c:\Users\harsh\OneDrive\Documents\Desktop\finalProject

# Full test suite sequentially (prevents database collision)
go test -p 1 -v ./...
```

Individual Modules test karne ke liye:
```powershell
# 1. Database Sharding & Fencing Tokens
go test -v ./internal/store/...

# 2. 1D Kalman Filter & AMD Classification
go test -v ./internal/pacing/... ./internal/provider/...

# 3. Multi-Carrier LCR Router & Trunk Hedging
go test -v ./internal/provider/... -run TestCarrierRouter

# 4. TCPA Timezones & CFPB Regulation F Compliance
go test -v ./internal/compliance/...

# 5. OpenTelemetry Tracing & Chaos Test Harness
go test -v ./internal/telemetry/... ./internal/chaos/...

# 6. Frontend Build Verification
cd web
npm run build
```

---

## 5. Common Troubleshooting & FAQs

### Q1: `failed to connect to docker API at npipe:////./pipe/dockerDesktopLinuxEngine`
- **Reason**: Docker Desktop application start nahi hai.
- **Solution**: Docker Desktop app ko open karein, ya simply **Method 1 (Local Native Setup)** follow karein jo aapke native PostgreSQL se bina Docker ke directly chalta hai.

### Q2: Port 5432 / 8080 already in use
- Agar port 8080 pe koi aur service chal rahi hai, to `main.go` me port change kar sakte hain, ya taskkill se free karein:
  ```powershell
  Get-Process -Id (Get-NetTCPConnection -LocalPort 8080).OwningProcess | Stop-Process -Force
  ```

### Q3: Frontend pe simulation table me data nahi dikh raha
- `simulation_results.json` generate karne ke liye Terminal me run karein:
  ```powershell
  go run cmd/simulator/main.go --all
  ```
  Aur browser refresh karein. Frontend ab automatically fallback data bhi display karta hai.

---

## 6. Architecture & Documentation Links
- [Architecture & Design Document](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/ARCHITECTURE.md)
- [Comprehensive System Design & Interview Guide](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/SYSTEM_GUIDE.md)
- [01. Database Sharding & PgBouncer](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/01_DATABASE_SHARDING_AND_PGBOUNCER.md)
- [02. Kalman Filter & AMD Engine](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/02_KALMAN_FILTER_AND_AMD.md)
- [03. Multi-Carrier LCR & Trunk Hedging](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/03_MULTI_CARRIER_LCR_AND_CIRCUIT_BREAKER.md)
- [04. Distributed Leases & Fencing Tokens](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/04_DISTRIBUTED_LEASES_AND_FENCING_TOKENS.md)
- [05. TCPA & Regulation F Compliance](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/05_TCPA_AND_REGULATION_F_COMPLIANCE.md)
- [06. Observability Tracing & Chaos Harness](file:///c:/Users/harsh/OneDrive/Documents/Desktop/finalProject/docs/06_OBSERVABILITY_TRACING_AND_CHAOS.md)
