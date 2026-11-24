package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
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

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		databaseURL = "postgres://postgres:postgres@localhost:5432/smartdialer?sslmode=disable"
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. Initialize PostgreSQL Pool
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		logger.Error("failed to parse database configuration", "err", err)
		os.Exit(1)
	}
	poolConfig.MaxConns = 30
	poolConfig.MinConns = 5

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		logger.Error("failed to create database pool", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	if err := pool.Ping(ctx); err != nil {
		logger.Error("database ping failed", "err", err)
		os.Exit(1)
	}
	logger.Info("connected to PostgreSQL", "database_url", databaseURL)

	st := store.NewPostgresStore(pool)
	if err := st.Migrate(ctx); err != nil {
		logger.Error("failed to execute migrations", "err", err)
		os.Exit(1)
	}
	logger.Info("database schema migrations applied successfully")

	// 2. Telecom Carrier Initialization
	provA := provider.NewMockProviderA(0.40, 90*time.Second)
	provA.RegisterWebhookHandler(func(ctx context.Context, event domain.CallEvent) error {
		return st.ProcessProviderEvent(ctx, event)
	})

	// 3. Pacing Engines & Safety Controller
	progressiveEngine := pacing.NewProgressiveEngine()
	predictiveEngine := pacing.NewPredictiveEngine()
	safetyController := safety.NewController(st)
	callAllocator := allocator.NewAllocator(st, provA)

	// 4. Worker Pool & Stale-State Reaper
	workerPool := worker.NewPool(4, st, progressiveEngine, safetyController, callAllocator, logger)
	reaper := worker.NewReaper(st, worker.DefaultReaperConfig(), logger)

	// Launch Reaper
	go reaper.Start(ctx)

	// 5. HTTP Router
	mux := http.NewServeMux()

	// Healthcheck
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":   "ok",
			"database": "connected",
			"carrier":  provA.Health(),
			"time":     time.Now().UTC(),
		})
	})

	// Create Agent
	mux.HandleFunc("POST /api/agents", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Name  string            `json:"name"`
			State domain.AgentState `json:"state"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.State == "" {
			req.State = domain.AgentAvailable
		}
		agent, err := st.CreateAgent(r.Context(), req.Name, req.State)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(agent)
	})

	// Create Borrower Lead
	mux.HandleFunc("POST /api/borrowers", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			PhoneNumber string `json:"phone_number"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		borrower, err := st.CreateBorrower(r.Context(), req.PhoneNumber)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(borrower)
	})

	// Start Campaign
	mux.HandleFunc("POST /api/campaigns/start", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			CampaignID string `json:"campaign_id"`
			Mode       string `json:"mode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)

		campUUID := uuid.New()
		if req.CampaignID != "" {
			if parsed, err := uuid.Parse(req.CampaignID); err == nil {
				campUUID = parsed
			}
		}

		if req.Mode == "PREDICTIVE" {
			workerPool.SetEngine(predictiveEngine)
		} else {
			workerPool.SetEngine(progressiveEngine)
		}

		workerPool.Start(ctx, campUUID)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"message":     "campaign dialer started",
			"campaign_id": campUUID,
			"mode":        req.Mode,
		})
	})

	// Stop Campaign
	mux.HandleFunc("POST /api/campaigns/stop", func(w http.ResponseWriter, r *http.Request) {
		workerPool.Stop()
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "campaign dialer stopped"})
	})

	// Webhook Ingestion
	mux.HandleFunc("POST /api/webhooks/{provider}", func(w http.ResponseWriter, r *http.Request) {
		var event domain.CallEvent
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if event.ID == uuid.Nil {
			event.ID = uuid.New()
		}
		if event.EventTimestamp.IsZero() {
			event.EventTimestamp = time.Now().UTC()
		}

		if err := st.ProcessProviderEvent(r.Context(), event); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "processed"})
	})

	// Metrics
	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		campStr := r.URL.Query().Get("campaign_id")
		campID := uuid.Nil
		if campStr != "" {
			campID, _ = uuid.Parse(campStr)
		}

		metrics, _ := st.GetPacingMetrics(r.Context(), campID)
		stats := workerPool.Stats()

		_ = json.NewEncoder(w).Encode(map[string]any{
			"pacing_metrics": metrics,
			"worker_stats":   stats,
		})
	})

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	// 6. Graceful Shutdown Management
	shutdownCh := make(chan os.Signal, 1)
	signal.Notify(shutdownCh, os.Interrupt, syscall.SIGTERM)

	go func() {
		logger.Info("SmartDialer server listening", "port", port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server listener error", "err", err)
			os.Exit(1)
		}
	}()

	sig := <-shutdownCh
	logger.Info("received shutdown signal, beginning graceful shutdown", "signal", sig.String())

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	workerPool.Stop()
	cancel()

	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.Error("HTTP server shutdown error", "err", err)
	}

	logger.Info("SmartDialer process exited cleanly")
}
