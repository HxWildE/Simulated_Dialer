# 02. State Machines & Call Lifecycle Decoded

Is chapter me hum samjhenge ki **Agent** aur **Call** ka jeevan-chakra (lifecycle) kaise chalta hai, aur kyun ek choti si galat transition pure system ko corrupt kar sakti hai.

---

## 1. Agent State Machine: Agent Ki Zindagi Ke 7 Padav

Ek call center agent sirf "Free" ya "Busy" nahi hota! Production systems me uske **7 distinct states** hote hain:

```
               ┌──────────┐
               │ OFFLINE  │ ◄─── (Shift start / Logged out)
               └────┬─────┘
                    │ Login
                    ▼
               ┌──────────┐
          ┌──► │AVAILABLE │ ◄─────────────────────────────────┐
          │    └────┬─────┘                                   │
          │         │ Allocator selects agent                 │
          │         ▼                                         │
          │    ┌──────────┐                                   │
          │    │ RESERVED │                                   │
          │    └────┬─────┘                                   │
          │         │ Telecom dial initiated                  │
          │         ▼                                         │
          │    ┌──────────┐                                   │
          │    │ DIALING  │ ── (Customer didn't answer) ───────┤
          │    └────┬─────┘                                   │
          │         │ Customer picks up ("Hello")             │
          │         ▼                                         │
          │    ┌──────────┐                                   │
          │    │CONNECTED │                                   │
          │    └────┬─────┘                                   │
          │         │ Call ends (Customer or Agent hangs up)  │
          │         ▼                                         │
          │    ┌──────────┐                                   │
          │    │ WRAP_UP  │ ── (Agent saves notes & ready) ───┘
          │    └────┬─────┘
          │         │ Agent takes lunch / tea break
          │         ▼
          │    ┌──────────┐
          └─── │  PAUSED  │
               └──────────┘
```

### Har State Ka Asli Maksad (Purpose):

1. **`OFFLINE`:** Agent ne system me login nahi kiya hai. Pacing engine isko count nahi karega.
2. **`AVAILABLE`:** Agent apni chair pe baitha hai, headset lagaya hua hai, aur ready hai. Yeh pacing engine ke liye free capacity hai ($A_{\text{avail}}$).
3. **`RESERVED`:** **(Sabse critical state!)**
   - *Kyun chahiye?* Jaise hi Allocator kisi agent ko select karta hai, usko fraction of a millisecond ke liye `RESERVED` mark kiya jata hai.
   - Yeh doosre concurrent workers ko bolta hai: *"Haath mat lagana, is agent ke liye lead fetch ho rahi hai!"*
4. **`DIALING`:** Telecom provider customer ka number mila raha hai. Agent abhi baat nahi kar raha, lekin wo busy hai (kisi aur call ko nahi le sakta).
5. **`CONNECTED`:** Customer ne "Hello" bola aur dono ka audio bridge ban gaya. Active conversation chal rahi hai.
6. **`WRAP_UP`:** Customer ne phone kaat diya. Lekin agent ko CRM me notes likhne hote hain (e.g. "Customer interested, call tomorrow at 5 PM"). Is time par usko nayi call nahi aani chahiye!
7. **`PAUSED`:** Agent bathroom break, lunch, ya training pe gaya hai.

---

## 2. Call State Machine: Lead Ka Safar

Har phone call database me ek record hoti hai. Uski transitions aisi hoti hain:

```
               ┌──────────┐
               │  QUEUED  │ (Lead imported from CRM / Campaign)
               └────┬─────┘
                    │ Pacing engine approves + Allocator locks
                    ▼
               ┌──────────┐
               │ RESERVED │
               └────┬─────┘
                    │ SIP INVITE sent to Telecom Carrier
                    ▼
               ┌──────────┐
               │INITIATED │
               └────┬─────┘
                    │ Carrier responds: 180 Ringing
                    ▼
               ┌──────────┐
          ┌──► │ RINGING  │
          │    └────┬─────┘
          │         │
          │         ├───────────────────────────────┐
          │         │ Customer picks up             │ Customer rejects / Voicemail / 45s timeout
          │         ▼                               ▼
          │    ┌──────────┐                   ┌──────────┐
          │    │ ANSWERED │                   │  FAILED  │ (Terminal)
          │    └────┬─────┘                   └──────────┘
          │         │
          │         ├───────────────────────────────┐
          │         │ Agent bridged within 2.0s     │ No agent free within 2.0s!
          │         ▼                               ▼
          │    ┌──────────┐                   ┌──────────┐
          │    │CONNECTED │                   │CANCELLED │ (Abandoned / Terminal)
          │    └────┬─────┘                   └──────────┘
          │         │
          │         │ Call finishes normally
          │         ▼
          │    ┌──────────┐
          └─── │COMPLETED │ (Terminal)
               └──────────┘
```

---

## 3. Sabse Bada Sawal: `ANSWERED` vs `CONNECTED` Me Kya Farak Hai?

Bohot saare junior engineers sochte hain ki "Answered" aur "Connected" ek hi baat hai. **Yeh sabse badi galti hoti hai!**

### Asli Farak:
1. **`ANSWERED`:**
   - Customer ne apne phone ka green button dabaya aur bola: *"Hello?"*
   - Yeh signal Telecom Carrier se hamare server pe webhook ban ke aata hai.
   - **Lekin abhi customer aur human agent baat nahi kar rahe!** Customer sirf telecom switch par hold par hai.
2. **`CONNECTED`:**
   - Hamara server telecom switch ko bolta hai: *"Customer audio stream aur Agent audio stream ko aapas me jod do (Bridge RTP stream)."*
   - Ab agent aur customer aapas me baat kar rahe hain.

### ⏱️ The 2-Second Legal Danger Zone:
Federal Law (TCPA) kehta hai:
> *"Jab customer ne phone uthaya (`ANSWERED`), toh theek **2.0 seconds** ke andar use human agent ki aawaz sunai deni chahiye (`CONNECTED`). Agar 2.0 second ke andar koi human agent nahi mila, toh aapko call turant disconnect (`CANCELLED / ABANDONED`) karni padegi aur ek recorded message bajana hoga!"*

Agar hum `ANSWERED` aur `CONNECTED` ko alag state na banate, toh hum yeh measure hi nahi kar pate ki hamara media bridge kitni milliseconds me ban raha hai!

---

## 4. State Transitions Ko Database Me Safe Kaise Rakhein?

Agar do threads ek sath update karein, toh "Split Brain" ya corrupt transition ho sakti hai.
Hamara codebase isko **Optimistic Concurrency Control (Version Field)** aur **Strict Transition Guards** se protect karta hai:

```go
// internal/domain/states.go
func (sm *CallStateMachine) CanTransition(from, to CallState) bool {
    allowed := map[CallState][]CallState{
        CallStateQueued:    {CallStateReserved, CallStateCancelled},
        CallStateReserved:  {CallStateInitiated, CallStateCancelled},
        CallStateInitiated: {CallStateRinging, CallStateFailed, CallStateCancelled},
        CallStateRinging:   {CallStateAnswered, CallStateFailed, CallStateCancelled},
        CallStateAnswered:  {CallStateConnected, CallStateCancelled},
        CallStateConnected: {CallStateCompleted, CallStateFailed},
    }
    // Agar koi illegal jump karne ki koshish karega (e.g. QUEUED seedha CONNECTED),
    // toh code turant error throw karega!
}
```
Isse koi bhi race condition system ko corrupt nahi kar sakti.
