# 02. Predictive Intelligence: 1D Kalman Filter & Answering Machine Detection (AMD)

## Executive Summary
This document explains the mathematical modeling and acoustic classification engines behind **SmartDialer**'s predictive intelligence:
1. A **1-Dimensional Recursive Kalman Filter** to estimate real-time borrower answer rates under dynamic regime shifts.
2. An **Answering Machine Detection (AMD)** engine to classify call audio patterns (Human vs. Voicemail/Machine) within the first 1.5–2.5 seconds of call setup.

---

## 1. The Problem

### 1.1 Limitations of Fixed EWMA in Collections Dialing
Traditional predictive dialers use an Exponentially Weighted Moving Average (EWMA):
$$\hat{p}_t = \alpha \cdot z_t + (1 - \alpha) \cdot \hat{p}_{t-1}$$
While simple, EWMA has severe mathematical drawbacks:
1. **Sample Size Blindness**: A batch of $N = 2$ calls with 1 answer is treated with the same weighting as a statistically significant batch of $N = 100$ calls with 50 answers.
2. **Lag vs. Noise Dilemma**: A small $\alpha$ (e.g., $0.05$) smooths noise but lags disastrously during carrier blocks (e.g., when answer rate plummets from $70\%$ to $10\%$). The dialer continues over-dialing, causing customer abandonment rate spikes ($>3\%$) and regulatory violations. Conversely, a high $\alpha$ (e.g., $0.5$) overreacts to random short-term variance.

### 1.2 Agent Idle Waste from Voicemails and Answering Machines
In collections dialing, $40\%\dots 60\%$ of answered calls connect to automated answering machines or carrier voicemail boxes.
- If routed to a human agent, the agent spends 30–60 seconds listening to voicemail prompts before manually disconnecting.
- This cuts effective agent talk time by up to **$50\%$**, doubling the cost per debt recovery interaction.

---

## 2. The Solution

### 2.1 1-Dimensional Recursive Kalman Filter
We model the true underlying borrower answer rate $x_k \in [0.01, 0.99]$ as a stochastic state variable observed through noisy batch outcomes $z_k$.

#### Mathematical Formulation:
1. **Time Update (Predict Step)**:
   - Prior State Estimate:
     $$x_k^- = x_{k-1}$$
   - Prior Error Covariance:
     $$P_k^- = P_{k-1} + Q$$
     *Where $Q$ is the Process Noise Covariance (e.g., $0.005$), representing the rate of volatility in borrower answer rates.*

2. **Measurement Noise Scaling ($R_k$)**:
   The measurement variance scales inversely with batch sample size $N$:
   $$R_k = \frac{R_{\text{base}}}{\sqrt{N_k}}$$
   *Larger batches reduce observation uncertainty, increasing the filter's confidence.*

3. **Measurement Update (Correct Step)**:
   - Dynamic Kalman Gain:
     $$K_k = \frac{P_k^-}{P_k^- + R_k}$$
   - Posterior State Estimate:
     $$x_k = x_k^- + K_k \cdot (z_k - x_k^-)$$
   - Posterior Error Covariance:
     $$P_k = (1 - K_k) \cdot P_k^-$$

```
   Noisy Batch Observations (z_k, N)
                  │
                  ▼
         ┌───────────────────┐
         │   Kalman Filter   │ ◄── Process Noise Q (Regime Shift Flexibility)
         │  Recursive Update │ ◄── Dynamic Measurement Noise R(N)
         └───────────────────┘
                  │
                  ▼
       Optimal Answer Rate (x_k)
                  │
                  ▼
         Little's Law Engine
   [ Dials = (Avail + Target) / x_k - Ringing ]
```

### 2.2 Answering Machine Detection (AMD) Decision Tree
The AMD classifier inspects acoustic and temporal energy patterns emitted by the SIP/RTP media gateway:

```
                          Inbound Audio Stream
                                   │
                     Continuous Tone >= 1000ms?
                     (Beep / SIT Tone 1000Hz)
                              /         \
                            YES          NO
                            /             \
                  [AMDSignalMachine]   Initial Silence >= 5000ms?
                                        (Dead Air Timeout)
                                         /         \
                                       YES          NO
                                       /             \
                             [AMDSignalSilence]  Greeting Duration >= 2200ms?
                                                 (Voicemail Announcement)
                                                  /         \
                                                YES          NO
                                                /             \
                                     [AMDSignalMachine]   Post-Greeting Silence >= 700ms?
                                                          (Human Conversational Pause)
                                                           /         \
                                                         YES          NO
                                                         /             \
                                               [AMDSignalHuman]   [AMDSignalUnsure]
```

#### Decision Rules:
1. **Sustained Tone**: Frequency $> 900\text{Hz}$ sustained for $\ge 1000\text{ms}$ immediately signals an answering machine beep.
2. **Dead Air**: Zero energy for $\ge 5000\text{ms}$ signals dead air / silence.
3. **Long Greeting**: Continuous energy $\ge 2200\text{ms}$ signals a voicemail message ("Hi, you have reached John Doe...").
4. **Human Speech**: Short greeting ($100\text{ms}\dots 1800\text{ms}$, e.g. "Hello?") followed by conversational silence ($\ge 700\text{ms}$) where the human waits for a response.

---

## 3. Code Implementation Breakdown

- **Kalman Filter**: `internal/pacing/kalman.go`
  - `NewKalmanAnswerRateFilter(initialEstimate, processNoise, baseMeasurementNoise)`
  - `Update(measuredRate float64, batchSize int) float64`
  - `Estimate() float64`
  - `Variance() float64`
- **AMD Engine**: `internal/provider/amd.go`
  - `AMDClassifier` with configurable thresholds.
  - `Classify(a AMDAnalysis) (AMDSignal, string)`
  - `AMDSignal` types: `HUMAN`, `MACHINE`, `SILENCE`, `UNSURE`.

---

## 4. Verification & Test Coverage

- **Kalman Tests (`internal/pacing/kalman_test.go`)**:
  - `TestKalmanFilter_InitialEstimateAndBounds`: Validates initialization and clamp bounds $[0.01, 0.99]$.
  - `TestKalmanFilter_NoiseSmoothing`: Verifies that oscillating measurements around $0.40$ converge with decreasing variance.
  - `TestKalmanFilter_RegimeShiftAdaptation`: Verifies that when answer rate drops from $70\%$ to $15\%$, the filter tracks down to $<0.25$ within 8 batches.
  - `TestKalmanFilter_BatchSizeWeighting`: Verifies that a batch of $N = 100$ has significantly higher Kalman gain than $N = 1$.
- **AMD Tests (`internal/provider/amd_test.go`)**:
  - `TestAMDClassifier_HumanSpeech`: 800ms speech + 1000ms pause $\to$ `AMDSignalHuman`.
  - `TestAMDClassifier_VoicemailLongGreeting`: 3200ms speech $\to$ `AMDSignalMachine`.
  - `TestAMDClassifier_ContinuousToneVoicemailBeep`: 1000Hz for 1200ms $\to$ `AMDSignalMachine`.
  - `TestAMDClassifier_DeadAirSilence`: 5500ms initial silence $\to$ `AMDSignalSilence`.
  - `TestAMDClassifier_UnsureInterrupted`: 500ms speech + 100ms pause $\to$ `AMDSignalUnsure`.
