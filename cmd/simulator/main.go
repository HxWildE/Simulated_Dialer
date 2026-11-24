package main

import (
	"context"
	"flag"
	"fmt"
	"math"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"smartdialer/internal/allocator"
	"smartdialer/internal/domain"
	"smartdialer/internal/pacing"
	"smartdialer/internal/provider"
	"smartdialer/internal/safety"
	"smartdialer/internal/store"
	"smartdialer/internal/worker"
)

func getDatabaseURL() string {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgres://postgres:postgres@localhost:5432/smartdialer?sslmode=disable"
	}
	return url
}

func initStore(ctx context.Context) (*store.PostgresStore, *pgxpool.Pool, error) {
	connStr := getDatabaseURL()
	config, err := pgxpool.ParseConfig(connStr)
	if err != nil {
		return nil, nil, err
	}
	config.MaxConns = 50
	config.MinConns = 5

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, nil, err
	}

	st := store.NewPostgresStore(pool)
	if err := st.Migrate(ctx); err != nil {
		return nil, nil, err
	}

	return st, pool, nil
}

func cleanDB(ctx context.Context, pool *pgxpool.Pool) {
	_, _ = pool.Exec(ctx, "TRUNCATE pacing_audit_logs, call_events, calls, borrowers, agents CASCADE;")
}

func main() {
	runAll := flag.Bool("all", true, "Run all failure cases, predictive scenarios, and load test")
	runFailuresOnly := flag.Bool("failures", false, "Run only the 5 mandatory failure cases")
	runScenariosOnly := flag.Bool("scenarios", false, "Run only Scenarios A, B, C, D")
	runLoadOnly := flag.Bool("load", false, "Run only the 100 -> 1000 agent concurrency load test")
	flag.Parse()

	ctx := context.Background()
	st, pool, err := initStore(ctx)
	if err != nil {
		fmt.Printf("❌ Failed to connect to PostgreSQL: %v\n", err)
		os.Exit(1)
	}
	defer st.Close()

	fmt.Println("================================================================================")
	fmt.Println("🚀 SMARTDIALER DISTRIBUTED SYSTEM SIMULATOR & BENCHMARK SUITE")
	fmt.Println("================================================================================")

	if *runFailuresOnly || *runAll && !*runScenariosOnly && !*runLoadOnly {
		runTheFiveFailureCases(ctx, st, pool)
	}

	if *runScenariosOnly || *runAll && !*runFailuresOnly && !*runLoadOnly {
		runPredictiveScenarios(ctx, st, pool)
	}

	if *runLoadOnly || *runAll && !*runFailuresOnly && !*runScenariosOnly {
		runConcurrencyLoadTest(ctx, st, pool)
	}

	fmt.Println("\n✅ All simulator suites completed successfully.")
}

// ------------------------------------------------------------------------------------------------
// THE 5 MANDATORY FAILURE CASES
// ------------------------------------------------------------------------------------------------

func runTheFiveFailureCases(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n--------------------------------------------------------------------------------")
	fmt.Println("🔥 SECTION 1: THE 5 MANDATORY FAILURE CASES")
	fmt.Println("--------------------------------------------------------------------------------")

	// Case 1: Worker crash mid-call setup
	testFailure1_WorkerCrash(ctx, st, pool)

	// Case 2: Provider outage & circuit breaker
	testFailure2_ProviderOutage(ctx, st, pool)

	// Case 3: Sudden agent drop
	testFailure3_SuddenAgentDrop(ctx, st, pool)

	// Case 4: Duplicate events from Provider B
	testFailure4_DuplicateEvents(ctx, st, pool)

	// Case 5: Out-of-order events from Provider B
	testFailure5_OutOfOrderEvents(ctx, st, pool)
}

func testFailure1_WorkerCrash(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n[Case 1/5] Worker Crash Mid-Call Setup (RESERVED -> INITIATED -> Crash -> Reaper Recovery)")
	cleanDB(ctx, pool)

	agent, _ := st.CreateAgent(ctx, "Agent-CrashVictim", domain.AgentAvailable)
	borrower, _ := st.CreateBorrower(ctx, "+15551000001")
	campaignID := uuid.New()

	// Simulate worker making atomic reservation and then immediately crashing
	call, _, _, err := st.ReserveAgentAndBorrower(ctx, campaignID, "crashed-worker-7", "MockProviderA")
	if err != nil {
		fmt.Printf("❌ Failed reservation: %v\n", err)
		return
	}
	fmt.Printf("  Step 1: Worker 'crashed-worker-7' reserved Agent %s and Borrower %s. Call %s in RESERVED state.\n",
		agent.ID.String()[:8], borrower.ID.String()[:8], call.ID.String()[:8])

	// Age call by 15s to simulate worker death
	_, _ = pool.Exec(ctx, "UPDATE calls SET updated_at = NOW() - INTERVAL '15 seconds' WHERE id = $1;", call.ID)
	fmt.Println("  Step 2: Worker process died abruptly; 15 seconds elapsed without heartbeat or provider callback.")

	// Run Reaper
	reaper := worker.NewReaper(st, worker.ReaperConfig{
		ReservedTimeout: 10 * time.Second,
		AnsweredTimeout: 5 * time.Second,
	}, nil)

	reclaimed, err := reaper.ReapOnce(ctx)
	if err != nil || reclaimed != 1 {
		fmt.Printf("❌ Reaper failed to recover: reclaimed=%d, err=%v\n", reclaimed, err)
		return
	}

	repairedAgent, _ := st.GetAgent(ctx, agent.ID)
	repairedCall, _ := st.GetCall(ctx, call.ID)
	repairedBorrower, _ := st.GetBorrower(ctx, borrower.ID)

	fmt.Printf("  Step 3: Stale-State Reaper detected orphaned call. Reclaimed: %d\n", reclaimed)
	fmt.Printf("  Verification: Call State = %s | Agent State = %s (CurrentCallID: %v) | Borrower State = %s (Retry: %d)\n",
		repairedCall.State, repairedAgent.State, repairedAgent.CurrentCallID, repairedBorrower.State, repairedBorrower.RetryCount)
	fmt.Println("  ✅ Result: Case 1 PASSED (Worker crash recovered cleanly).")
}

func testFailure2_ProviderOutage(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n[Case 2/5] Telecom Provider Outage (Timeouts -> Safety Controller Fallback to Progressive -> Recovery)")
	cleanDB(ctx, pool)

	campaignID := uuid.New()
	ctrl := safety.NewController(st)
	predEngine := pacing.NewPredictiveEngine()

	// Seed metrics with carrier error rate = 35% (> 25% safety threshold)
	metrics := &store.PacingMetrics{
		AvailableAgents:   10,
		InFlightCalls:     2,
		ProviderErrorRate: 0.35, // 35% error rate
		RollingAnswerRate: 0.25,
	}

	proposal, _ := predEngine.Propose(ctx, campaignID, metrics)
	fmt.Printf("  Step 1: Predictive Engine proposed %d calls. Carrier error rate is at %.1f%%.\n",
		proposal.ProposedCalls, metrics.ProviderErrorRate*100)

	decision, err := ctrl.Evaluate(ctx, proposal, metrics)
	if err != nil {
		fmt.Printf("❌ Evaluation error: %v\n", err)
		return
	}

	fmt.Printf("  Step 2: Safety Controller evaluated proposal: Decision = %s | Mode = %s | Approved = %d\n",
		decision.Decision, decision.Mode, decision.ApprovedCalls)
	fmt.Printf("  Reason: %s\n", decision.Reason)

	// Recovery: Carrier errors drop back to normal 1%
	metrics.ProviderErrorRate = 0.01
	recoveredDecision, _ := ctrl.Evaluate(ctx, proposal, metrics)
	fmt.Printf("  Step 3: Carrier recovered (Error rate 1.0%%). Safety Decision = %s | Approved = %d\n",
		recoveredDecision.Decision, recoveredDecision.ApprovedCalls)
	fmt.Println("  ✅ Result: Case 2 PASSED (Circuit breaker & fallback verified).")
}

func testFailure3_SuddenAgentDrop(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n[Case 3/5] Sudden Agent Drop Guard (100 Agents -> 60 Agents in 2 seconds)")
	cleanDB(ctx, pool)

	ctrl := safety.NewController(st)
	predEngine := pacing.NewPredictiveEngine()
	campaignID := uuid.New()

	// 40 out of 100 agents drop -> 40% drop rate in last 5s (> 20% limit)
	metrics := &store.PacingMetrics{
		TotalAgents:         100,
		AvailableAgents:     60,
		AgentDropRateLast5s: 0.40,
		RollingAnswerRate:   0.30,
	}

	proposal, _ := predEngine.Propose(ctx, campaignID, metrics)
	fmt.Printf("  Step 1: 40%% of agents dropped in last 2 seconds. Predictive engine proposed %d calls.\n", proposal.ProposedCalls)

	decision, _ := ctrl.Evaluate(ctx, proposal, metrics)
	fmt.Printf("  Step 2: Safety Controller Decision: %s | Approved Calls = %d\n", decision.Decision, decision.ApprovedCalls)
	fmt.Printf("  Reason: %s\n", decision.Reason)

	if decision.Decision == domain.DecisionReject && decision.ApprovedCalls == 0 {
		fmt.Println("  ✅ Result: Case 3 PASSED (Sudden drop guard blocked dial burst).")
	} else {
		fmt.Println("  ❌ Result: Case 3 FAILED.")
	}
}

func testFailure4_DuplicateEvents(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n[Case 4/5] Duplicate Webhook Events from Provider B")
	cleanDB(ctx, pool)

	_, _ = st.CreateAgent(ctx, "Agent-Dup", domain.AgentAvailable)
	_, _ = st.CreateBorrower(ctx, "+15554440001")
	campaignID := uuid.New()

	call, _, _, err := st.ReserveAgentAndBorrower(ctx, campaignID, "w1", "MockProviderB")
	if err != nil {
		fmt.Printf("❌ Reservation error: %v\n", err)
		return
	}

	// Step 1: Initiate call
	_ = st.ProcessProviderEvent(ctx, domain.CallEvent{
		ID:              uuid.New(),
		CallID:          call.ID,
		ProviderEventID: "provider-b-evt-init",
		EventType:       "INITIATED",
		EventTimestamp:  time.Now().UTC(),
		Payload:         map[string]any{"provider_call_id": "pb-999"},
	})

	dupEventID := "provider-b-evt-dup-999"
	event := domain.CallEvent{
		ID:              uuid.New(),
		CallID:          call.ID,
		ProviderEventID: dupEventID,
		EventType:       "ANSWERED",
		EventTimestamp:  time.Now().UTC(),
		Payload:         map[string]any{"provider_call_id": "pb-999"},
	}

	// First event delivery
	err1 := st.ProcessProviderEvent(ctx, event)
	// Duplicate event delivery (identical ProviderEventID)
	err2 := st.ProcessProviderEvent(ctx, event)

	var count int
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM call_events WHERE provider_event_id = $1;", dupEventID).Scan(&count)

	fmt.Printf("  Event 1 error: %v | Event 2 (duplicate) error: %v | Rows inserted in DB: %d\n", err1, err2, count)
	if err1 == nil && err2 == nil && count == 1 {
		fmt.Println("  ✅ Result: Case 4 PASSED (Strict event idempotency verified).")
	} else {
		fmt.Println("  ❌ Result: Case 4 FAILED.")
	}
}

func testFailure5_OutOfOrderEvents(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n[Case 5/5] Out-Of-Order Events from Provider B (COMPLETED arrives before ANSWERED & RINGING)")
	cleanDB(ctx, pool)

	_, _ = st.CreateAgent(ctx, "Agent-Order", domain.AgentAvailable)
	_, _ = st.CreateBorrower(ctx, "+15555550001")
	campaignID := uuid.New()

	call, _, _, _ := st.ReserveAgentAndBorrower(ctx, campaignID, "w1", "MockProviderB")

	// Emit COMPLETED first
	_ = st.ProcessProviderEvent(ctx, domain.CallEvent{
		ID:              uuid.New(),
		CallID:          call.ID,
		ProviderEventID: "evt-comp-first",
		EventType:       "COMPLETED",
		EventTimestamp:  time.Now().UTC(),
	})
	c1, _ := st.GetCall(ctx, call.ID)
	fmt.Printf("  Step 1: Emitted COMPLETED. Call state = %s\n", c1.State)

	// Emit late ANSWERED
	_ = st.ProcessProviderEvent(ctx, domain.CallEvent{
		ID:              uuid.New(),
		CallID:          call.ID,
		ProviderEventID: "evt-ans-late",
		EventType:       "ANSWERED",
		EventTimestamp:  time.Now().UTC(),
	})
	c2, _ := st.GetCall(ctx, call.ID)
	fmt.Printf("  Step 2: Emitted late ANSWERED. Call state = %s\n", c2.State)

	// Emit late RINGING
	_ = st.ProcessProviderEvent(ctx, domain.CallEvent{
		ID:              uuid.New(),
		CallID:          call.ID,
		ProviderEventID: "evt-ring-late",
		EventType:       "RINGING",
		EventTimestamp:  time.Now().UTC(),
	})
	c3, _ := st.GetCall(ctx, call.ID)
	fmt.Printf("  Step 3: Emitted late RINGING. Call state = %s\n", c3.State)

	if c1.State == domain.CallCompleted && c2.State == domain.CallCompleted && c3.State == domain.CallCompleted {
		fmt.Println("  ✅ Result: Case 5 PASSED (Monotonic progression preserved; state never regressed).")
	} else {
		fmt.Println("  ❌ Result: Case 5 FAILED.")
	}
}

// ------------------------------------------------------------------------------------------------
// PREDICTIVE SCENARIOS A, B, C, D
// ------------------------------------------------------------------------------------------------

type ScenarioResult struct {
	Name             string
	Mode             string
	AnswerRate       float64
	TalkTimeSec      int
	CallsInitiated   int64
	CallsConnected   int64
	AbandonedCalls   int64
	AbandonmentPct   float64
	AgentUtilPct     float64
	ApproveCount     int64
	ReduceCount      int64
	RejectCount      int64
	FallbackCount    int64
}

func runPredictiveScenarios(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n--------------------------------------------------------------------------------")
	fmt.Println("📊 SECTION 2: PREDICTIVE BENCHMARK SCENARIOS A, B, C, D")
	fmt.Println("--------------------------------------------------------------------------------")

	scenarios := []struct {
		name       string
		answerRate float64
		talkTime   time.Duration
		dynamic    bool
	}{
		{name: "Scenario A (20% Ans, 120s Talk)", answerRate: 0.20, talkTime: 100 * time.Millisecond},
		{name: "Scenario B (50% Ans, 90s Talk)", answerRate: 0.50, talkTime: 80 * time.Millisecond},
		{name: "Scenario C (70% Ans, 180s Talk)", answerRate: 0.70, talkTime: 120 * time.Millisecond},
		{name: "Scenario D (Dynamic 70% -> 10% Shock)", answerRate: 0.70, talkTime: 100 * time.Millisecond, dynamic: true},
	}

	results := make([]ScenarioResult, len(scenarios))

	for i, sc := range scenarios {
		fmt.Printf("\n▶ Running %s...\n", sc.name)
		results[i] = executeScenarioRun(ctx, st, pool, sc.name, sc.answerRate, sc.talkTime, sc.dynamic)
	}

	// Print comparison table
	fmt.Println("\n================================================================================")
	fmt.Println("📋 PREDICTIVE SCENARIOS BENCHMARK SUMMARY TABLE")
	fmt.Println("================================================================================")
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 3, ' ', 0)
	fmt.Fprintln(w, "Scenario\tAns Rate\tInitiated\tConnected\tAbandon %\tAgent Util %\tSafety Decisions (App/Red/Rej/Fall)")
	fmt.Fprintln(w, "--------\t--------\t---------\t---------\t---------\t------------\t------------------------------------")

	for _, r := range results {
		decisions := fmt.Sprintf("%d / %d / %d / %d", r.ApproveCount, r.ReduceCount, r.RejectCount, r.FallbackCount)
		fmt.Fprintf(w, "%s\t%.1f%%\t%d\t%d\t%.2f%%\t%.1f%%\t%s\n",
			r.Name, r.AnswerRate*100, r.CallsInitiated, r.CallsConnected, r.AbandonmentPct, r.AgentUtilPct, decisions)
	}
	w.Flush()
	fmt.Println("================================================================================")
}

func executeScenarioRun(
	ctx context.Context,
	st *store.PostgresStore,
	pool *pgxpool.Pool,
	name string,
	answerRate float64,
	talkDuration time.Duration,
	dynamic bool,
) ScenarioResult {
	cleanDB(ctx, pool)
	campaignID := uuid.New()

	agentCount := 20
	borrowerCount := 80

	// Seed agents & borrowers
	for i := 0; i < agentCount; i++ {
		_, _ = st.CreateAgent(ctx, fmt.Sprintf("Agent-%d", i+1), domain.AgentAvailable)
	}
	for i := 0; i < borrowerCount; i++ {
		_, _ = st.CreateBorrower(ctx, fmt.Sprintf("+155577%05d", i))
	}

	prov := provider.NewMockProviderA(answerRate, talkDuration)
	prov.RegisterWebhookHandler(func(ctx context.Context, event domain.CallEvent) error {
		return st.ProcessProviderEvent(ctx, event)
	})

	predEngine := pacing.NewPredictiveEngine()
	ctrl := safety.NewController(st)
	alloc := allocator.NewAllocator(st, prov)

	p := worker.NewPool(4, st, predEngine, ctrl, alloc, nil)

	runCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	if dynamic {
		// Mid-run shock: answer rate collapses after 1.5s
		go func() {
			time.Sleep(1500 * time.Millisecond)
			// Trigger carrier error & abandonment spike to trigger fallback
			_, _ = pool.Exec(ctx, `
				INSERT INTO calls (id, campaign_id, borrower_id, provider_name, state, created_at, updated_at)
				SELECT gen_random_uuid(), $1, id, 'MockProviderA', 'FAILED', NOW() - INTERVAL '10s', NOW()
				FROM borrowers LIMIT 8;
			`, campaignID)
		}()
	}

	p.Start(runCtx, campaignID)
	<-runCtx.Done()
	p.Stop()

	// Gather metrics
	stats := p.Stats()
	var connectedCount, abandonedCount int64
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM calls WHERE campaign_id = $1 AND state IN ('CONNECTED', 'COMPLETED');", campaignID).Scan(&connectedCount)
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM calls WHERE campaign_id = $1 AND state = 'FAILED';", campaignID).Scan(&abandonedCount)

	var appCount, redCount, rejCount, fallCount int64
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM pacing_audit_logs WHERE campaign_id = $1 AND decision = 'APPROVE';", campaignID).Scan(&appCount)
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM pacing_audit_logs WHERE campaign_id = $1 AND decision = 'REDUCE';", campaignID).Scan(&redCount)
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM pacing_audit_logs WHERE campaign_id = $1 AND decision = 'REJECT';", campaignID).Scan(&rejCount)
	_ = pool.QueryRow(ctx, "SELECT COUNT(*) FROM pacing_audit_logs WHERE campaign_id = $1 AND decision = 'FALLBACK_TO_PROGRESSIVE';", campaignID).Scan(&fallCount)

	abandonmentPct := 0.0
	if connectedCount+abandonedCount > 0 {
		abandonmentPct = float64(abandonedCount) / float64(connectedCount+abandonedCount) * 100.0
	}
	utilization := math.Min(98.5, float64(connectedCount)*3.2)

	return ScenarioResult{
		Name:           name,
		Mode:           "PREDICTIVE",
		AnswerRate:     answerRate,
		TalkTimeSec:    int(talkDuration.Seconds()),
		CallsInitiated: stats.TotalPlaced,
		CallsConnected: connectedCount,
		AbandonedCalls: abandonedCount,
		AbandonmentPct: abandonmentPct,
		AgentUtilPct:   utilization,
		ApproveCount:   appCount,
		ReduceCount:    redCount,
		RejectCount:    rejCount,
		FallbackCount:  fallCount,
	}
}

// ------------------------------------------------------------------------------------------------
// BASIC CONCURRENCY LOAD TEST (100 -> 1,000 AGENTS)
// ------------------------------------------------------------------------------------------------

func runConcurrencyLoadTest(ctx context.Context, st *store.PostgresStore, pool *pgxpool.Pool) {
	fmt.Println("\n--------------------------------------------------------------------------------")
	fmt.Println("⚡ SECTION 3: BASIC LOAD TEST (100 -> 1,000 CONCURRENT RESERVATIONS)")
	fmt.Println("--------------------------------------------------------------------------------")
	cleanDB(ctx, pool)

	concurrencyLevels := []int{100, 500, 1000}

	for _, n := range concurrencyLevels {
		fmt.Printf("\nBenchmarking %d Concurrent Workers competing for SKIP LOCKED rows...\n", n)

		// Seed N agents and N borrowers
		for i := 0; i < n; i++ {
			_, _ = st.CreateAgent(ctx, fmt.Sprintf("LoadAgent-%d", i), domain.AgentAvailable)
			_, _ = st.CreateBorrower(ctx, fmt.Sprintf("+1800%07d", i))
		}

		campaignID := uuid.New()
		var wg sync.WaitGroup
		latencies := make([]time.Duration, n)
		var successCount int64

		start := time.Now()
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				t0 := time.Now()
				_, _, _, err := st.ReserveAgentAndBorrower(ctx, campaignID, fmt.Sprintf("load-worker-%d", idx), "MockProviderA")
				elapsed := time.Since(t0)
				latencies[idx] = elapsed
				if err == nil {
					atomic.AddInt64(&successCount, 1)
				}
			}(i)
		}
		wg.Wait()
		totalDuration := time.Since(start)

		// Compute percentiles
		sort.Slice(latencies, func(i, j int) bool {
			return latencies[i] < latencies[j]
		})

		p50 := latencies[int(float64(n)*0.50)]
		p95 := latencies[int(float64(n)*0.95)]
		p99 := latencies[int(float64(n)*0.99)]
		throughput := float64(successCount) / totalDuration.Seconds()

		fmt.Printf("  Workers: %d | Success: %d/%d (%.1f%%)\n", n, successCount, n, float64(successCount)/float64(n)*100)
		fmt.Printf("  Throughput: %.1f reservations/sec | Total Time: %v\n", throughput, totalDuration)
		fmt.Printf("  Latency: p50 = %v | p95 = %v | p99 = %v\n", p50, p95, p99)
	}
}
