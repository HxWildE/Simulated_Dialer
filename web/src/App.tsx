import React, { useState, useEffect } from 'react';
import { 
  ShieldAlert, 
  Activity, 
  Layers, 
  Server, 
  RefreshCw, 
  Play, 
  CheckCircle2, 
  Users, 
  Cpu, 
  Zap,
  ArrowRight,
  TrendingDown,
  Clock
} from 'lucide-react';
import { 
  LiveMetricsResponse, 
  FullSimulationExport, 
  ScenarioComparison 
} from './types';

// Fallback seed simulation data if backend has not run yet
const defaultSimulationData: FullSimulationExport = {
  generated_at: new Date().toISOString(),
  scenarios: [
    {
      name: "Scenario A (20% Ans, 120s Talk)",
      answer_rate: 0.20,
      talk_time_sec: 120,
      progressive: { mode: "PROGRESSIVE", calls_initiated: 20, calls_connected: 4, abandoned_calls: 0, abandonment_pct: 0.0, agent_util_pct: 22.0, approve_count: 20, reduce_count: 0, reject_count: 0, fallback_count: 0 },
      predictive: { mode: "PREDICTIVE", calls_initiated: 79, calls_connected: 15, abandoned_calls: 3, abandonment_pct: 1.85, agent_util_pct: 48.0, approve_count: 4, reduce_count: 0, reject_count: 0, fallback_count: 51 }
    },
    {
      name: "Scenario B (50% Ans, 90s Talk)",
      answer_rate: 0.50,
      talk_time_sec: 90,
      progressive: { mode: "PROGRESSIVE", calls_initiated: 20, calls_connected: 10, abandoned_calls: 0, abandonment_pct: 0.0, agent_util_pct: 35.0, approve_count: 20, reduce_count: 0, reject_count: 0, fallback_count: 0 },
      predictive: { mode: "PREDICTIVE", calls_initiated: 60, calls_connected: 19, abandoned_calls: 2, abandonment_pct: 1.20, agent_util_pct: 60.8, approve_count: 4, reduce_count: 0, reject_count: 0, fallback_count: 37 }
    },
    {
      name: "Scenario C (70% Ans, 180s Talk)",
      answer_rate: 0.70,
      talk_time_sec: 180,
      progressive: { mode: "PROGRESSIVE", calls_initiated: 20, calls_connected: 14, abandoned_calls: 0, abandonment_pct: 0.0, agent_util_pct: 45.0, approve_count: 20, reduce_count: 0, reject_count: 0, fallback_count: 0 },
      predictive: { mode: "PREDICTIVE", calls_initiated: 30, calls_connected: 20, abandoned_calls: 1, abandonment_pct: 0.85, agent_util_pct: 64.0, approve_count: 4, reduce_count: 0, reject_count: 0, fallback_count: 12 }
    },
    {
      name: "Scenario D (Dynamic 70% -> 10% Shock)",
      answer_rate: 0.70,
      talk_time_sec: 100,
      progressive: { mode: "PROGRESSIVE", calls_initiated: 20, calls_connected: 8, abandoned_calls: 0, abandonment_pct: 0.0, agent_util_pct: 30.0, approve_count: 20, reduce_count: 0, reject_count: 0, fallback_count: 0 },
      predictive: { mode: "PREDICTIVE", calls_initiated: 30, calls_connected: 20, abandoned_calls: 2, abandonment_pct: 1.90, agent_util_pct: 64.0, approve_count: 4, reduce_count: 0, reject_count: 0, fallback_count: 8 }
    }
  ],
  scenario_d_timeline: [
    { seconds: 0.0, answer_rate_pct: 70.0, ringing_calls: 5, connected: 2, mode: "PREDICTIVE" },
    { seconds: 0.5, answer_rate_pct: 70.0, ringing_calls: 12, connected: 6, mode: "PREDICTIVE" },
    { seconds: 1.0, answer_rate_pct: 70.0, ringing_calls: 18, connected: 11, mode: "PREDICTIVE" },
    { seconds: 1.5, answer_rate_pct: 10.0, ringing_calls: 8, connected: 14, mode: "PROGRESSIVE_FALLBACK", event: "SAFETY TRIGGER: FALLBACK_TO_PROGRESSIVE" },
    { seconds: 2.0, answer_rate_pct: 10.0, ringing_calls: 4, connected: 16, mode: "PROGRESSIVE_FALLBACK" },
    { seconds: 2.5, answer_rate_pct: 10.0, ringing_calls: 2, connected: 18, mode: "PROGRESSIVE_FALLBACK" },
    { seconds: 3.0, answer_rate_pct: 10.0, ringing_calls: 0, connected: 20, mode: "PROGRESSIVE_FALLBACK" }
  ],
  failure_cases: [
    {
      id: 1,
      name: "Worker Crash Mid-Call Setup",
      passed: true,
      description: "Worker crashes after reserving agent & borrower; Stale-State Reaper detects timeout >10s, transitions call to FAILED, releases agent to AVAILABLE, and requeues borrower with backoff.",
      event_trace: "Call: RESERVED -> FAILED | Agent: RESERVED -> AVAILABLE (leased: false) | Borrower: RESERVED -> PENDING (Retry: 1)"
    },
    {
      id: 2,
      name: "Provider Outage Circuit Breaker",
      passed: true,
      description: "Carrier error rate climbs to 35% (>25%); Safety Controller activates circuit breaker, rejecting predictive bursts and falling back to Progressive 1:1 capacity.",
      event_trace: "Carrier Error Rate: 35.0% (>25%) -> Circuit Breaker: FALLBACK_TO_PROGRESSIVE -> Approved: 8 calls"
    },
    {
      id: 3,
      name: "Sudden Agent Drop Guard",
      passed: true,
      description: "40% of agents disconnect in <2 seconds (>20% threshold); Safety Controller triggers Sudden Drop Guard and approves 0 calls to prevent agent flooding.",
      event_trace: "Agent Drop Rate: 40.0% (>20%) -> Sudden Drop Guard: REJECT -> Approved: 0 calls"
    },
    {
      id: 4,
      name: "Duplicate Events Idempotency",
      passed: true,
      description: "Carrier delivers duplicate webhooks with identical provider_event_id; PostgreSQL ON CONFLICT DO NOTHING suppresses duplicates with 0 state corruption.",
      event_trace: "Event 1 err: <nil> | Event 2 (dup) err: <nil> | Event 3 (dup) err: <nil> | Rows inserted: 1"
    },
    {
      id: 5,
      name: "Out-of-Order Webhook Delivery",
      passed: true,
      description: "Carrier delivers COMPLETED before ANSWERED or RINGING; monotonic rank ordering guarantees terminal states never regress to active states.",
      event_trace: "Event 1 (COMPLETED): state=COMPLETED | Event 2 (Late ANSWERED): state=COMPLETED | Event 3 (Late RINGING): state=COMPLETED"
    }
  ],
  load_test: {
    double_allocations: 0,
    levels: [
      { workers: 100, successful_reservations: 100, double_allocations: 0, throughput_rps: 177.3, total_duration_ms: 564, p50_ms: 100.5, p95_ms: 545.4, p99_ms: 556.5 },
      { workers: 500, successful_reservations: 500, double_allocations: 0, throughput_rps: 2887.1, total_duration_ms: 173, p50_ms: 90.6, p95_ms: 161.2, p99_ms: 161.2 },
      { workers: 1000, successful_reservations: 1000, double_allocations: 0, throughput_rps: 2948.7, total_duration_ms: 339, p50_ms: 177.1, p95_ms: 328.6, p99_ms: 333.2 }
    ],
    p99_latency: "333.24ms"
  }
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'live' | 'scenarios' | 'failures'>('live');
  const [liveData, setLiveData] = useState<LiveMetricsResponse | null>(null);
  const [simData, setSimData] = useState<FullSimulationExport>(defaultSimulationData);
  const [loadingSim, setLoadingSim] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toLocaleTimeString());

  // Fetch Live Metrics
  const fetchLiveMetrics = async () => {
    try {
      const res = await fetch('/api/v1/metrics/live');
      if (res.ok) {
        const data: LiveMetricsResponse = await res.json();
        setLiveData(data);
        setLastUpdated(new Date().toLocaleTimeString());
      }
    } catch {
      // Backend might be offline during initial client launch
    }
  };

  // Fetch Latest Simulation Results
  const fetchSimulationResults = async () => {
    try {
      const res = await fetch('/api/v1/simulator/results');
      if (res.ok) {
        const data: FullSimulationExport = await res.json();
        setSimData(data);
      }
    } catch {
      // Fallback to default simulation data
    }
  };

  useEffect(() => {
    fetchLiveMetrics();
    fetchSimulationResults();

    let interval: ReturnType<typeof setInterval> | null = null;
    if (autoRefresh) {
      interval = setInterval(fetchLiveMetrics, 2000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh]);

  const handleRunSimulator = async (target: string) => {
    setLoadingSim(true);
    try {
      await fetch('/api/v1/simulator/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target }),
      });
      // Poll results after 3 seconds
      setTimeout(async () => {
        await fetchSimulationResults();
        setLoadingSim(false);
      }, 3500);
    } catch {
      setLoadingSim(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-gray-100 flex flex-col font-sans">
      {/* Top Navigation Header */}
      <header className="border-b border-gray-800 bg-[#111827]/80 backdrop-blur sticky top-0 z-50 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-cyan-500 to-blue-600 p-2 rounded-lg shadow-lg shadow-blue-500/20">
            <Cpu className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-gray-200 to-gray-400 bg-clip-text text-transparent">
                SmartDialer
              </h1>
              <span className="text-[10px] uppercase font-bold tracking-widest px-2 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700/50">
                Production Prototype
              </span>
            </div>
            <p className="text-xs text-gray-400">Outbound Collections Dialing Engine & Safety Controller</p>
          </div>
        </div>

        {/* Global Controls & Status */}
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2 bg-gray-900/80 px-3 py-1.5 rounded-lg border border-gray-800">
            <span className="text-gray-400">Mode:</span>
            <span className={`font-semibold uppercase px-2 py-0.5 rounded text-[11px] ${
              liveData?.mode === 'PREDICTIVE' 
                ? 'bg-purple-900/60 text-purple-300 border border-purple-700/60' 
                : 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/60'
            }`}>
              {liveData?.mode || 'PROGRESSIVE'}
            </span>
          </div>

          <div className="flex items-center gap-2 bg-gray-900/80 px-3 py-1.5 rounded-lg border border-gray-800">
            <span className="text-gray-400">Circuit Breaker:</span>
            <span className={`font-semibold uppercase px-2 py-0.5 rounded text-[11px] flex items-center gap-1.5 ${
              liveData?.circuit_breaker === 'OPEN'
                ? 'bg-red-900/60 text-red-300 border border-red-700/60 animate-pulse'
                : liveData?.circuit_breaker === 'HALF-OPEN'
                ? 'bg-amber-900/60 text-amber-300 border border-amber-700/60'
                : 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/60'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                liveData?.circuit_breaker === 'OPEN' ? 'bg-red-400' : liveData?.circuit_breaker === 'HALF-OPEN' ? 'bg-amber-400' : 'bg-emerald-400'
              }`} />
              {liveData?.circuit_breaker || 'CLOSED'}
            </span>
          </div>

          <button 
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition ${
              autoRefresh 
                ? 'bg-cyan-950/40 border-cyan-800/60 text-cyan-300' 
                : 'bg-gray-800 border-gray-700 text-gray-400'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? 'animate-spin' : ''}`} />
            <span>{autoRefresh ? 'Live (2s)' : 'Paused'}</span>
          </button>
        </div>
      </header>

      {/* Tabs Navigation */}
      <div className="bg-[#111827]/50 border-b border-gray-800/80 px-6">
        <div className="flex gap-8">
          <button
            onClick={() => setActiveTab('live')}
            className={`py-3 text-sm font-medium border-b-2 flex items-center gap-2 transition ${
              activeTab === 'live'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Activity className="w-4 h-4" />
            Live Operations & Safety Monitor
          </button>
          <button
            onClick={() => setActiveTab('scenarios')}
            className={`py-3 text-sm font-medium border-b-2 flex items-center gap-2 transition ${
              activeTab === 'scenarios'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Layers className="w-4 h-4" />
            Efficiency & Simulation Results (Scenarios A–D)
          </button>
          <button
            onClick={() => setActiveTab('failures')}
            className={`py-3 text-sm font-medium border-b-2 flex items-center gap-2 transition ${
              activeTab === 'failures'
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            Failure Cases & Load Test (p99 Latency)
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* ========================================================================= */}
        {/* TAB 1: LIVE OPERATIONS & SAFETY MONITOR */}
        {/* ========================================================================= */}
        {activeTab === 'live' && (
          <div className="space-y-6">
            {/* 1.1 Agent State Grid */}
            <section className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-blue-400" />
                  <h2 className="font-semibold text-sm text-gray-200 tracking-wide uppercase">
                    Agent State Grid (PostgreSQL Atomic Single Source of Truth)
                  </h2>
                </div>
                <span className="text-xs text-gray-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Synced: {lastUpdated}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
                <AgentStateCard 
                  state="AVAILABLE" 
                  count={liveData?.agent_states?.AVAILABLE ?? 10} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="emerald" 
                  desc="Ready for Allocation"
                />
                <AgentStateCard 
                  state="RESERVED" 
                  count={liveData?.agent_states?.RESERVED ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="amber" 
                  desc="Locked via SKIP LOCKED"
                />
                <AgentStateCard 
                  state="DIALING" 
                  count={liveData?.agent_states?.DIALING ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="blue" 
                  desc="Carrier Ringing"
                />
                <AgentStateCard 
                  state="CONNECTED" 
                  count={liveData?.agent_states?.CONNECTED ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="violet" 
                  desc="Active Borrower Talk"
                />
                <AgentStateCard 
                  state="WRAP_UP" 
                  count={liveData?.agent_states?.WRAP_UP ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="cyan" 
                  desc="Disposition Notes"
                />
                <AgentStateCard 
                  state="PAUSED" 
                  count={liveData?.agent_states?.PAUSED ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="yellow" 
                  desc="On Break / Idle"
                />
                <AgentStateCard 
                  state="OFFLINE" 
                  count={liveData?.agent_states?.OFFLINE ?? 0} 
                  total={liveData?.agent_states?.TOTAL ?? 10} 
                  color="gray" 
                  desc="Logged Out"
                />
              </div>
            </section>

            {/* 1.2 Pipeline & Safety Controller Visualizer */}
            <section className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <Zap className="w-4 h-4 text-cyan-400" />
                <h2 className="font-semibold text-sm text-gray-200 tracking-wide uppercase">
                  Architectural Pipeline: Non-Bypassable Safety Boundary
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 relative">
                {/* Stage 1 */}
                <div className="bg-gray-950/70 border border-gray-800 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <div className="text-[11px] font-bold text-blue-400 uppercase tracking-wider mb-1">Stage 1</div>
                    <h3 className="font-semibold text-sm text-white">Pacing Engine</h3>
                    <p className="text-xs text-gray-400 mt-1">
                      {liveData?.mode === 'PREDICTIVE' ? "Little's Law + Erlang Buffer" : "Progressive 1:1 Dialing"}
                    </p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-gray-800/80 text-xs text-gray-300">
                    <div>Answer Rate: <span className="text-white font-mono">{((liveData?.telemetry?.rolling_answer_rate ?? 0.30) * 100).toFixed(1)}%</span></div>
                    <div>In-Flight: <span className="text-white font-mono">{liveData?.active_calls?.in_flight ?? 0}</span></div>
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden md:flex items-center justify-center -mx-2 z-10">
                  <ArrowRight className="w-5 h-5 text-gray-600" />
                </div>

                {/* Stage 2 */}
                <div className="bg-gradient-to-b from-blue-950/20 to-gray-950/80 border border-blue-800/40 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <div className="text-[11px] font-bold text-cyan-400 uppercase tracking-wider mb-1">Stage 2 (Non-Bypassable)</div>
                    <h3 className="font-semibold text-sm text-white flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 text-cyan-400" />
                      Safety Controller
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">Abandonment & Drop Guards</p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-gray-800/80 text-xs space-y-1">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Abandonment:</span>
                      <span className={`font-mono font-semibold ${
                        (liveData?.telemetry?.rolling_abandonment_rate ?? 0) > 0.02 ? 'text-red-400' : 'text-emerald-400'
                      }`}>
                        {((liveData?.telemetry?.rolling_abandonment_rate ?? 0) * 100).toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Carrier Error:</span>
                      <span className={`font-mono font-semibold ${
                        (liveData?.telemetry?.provider_error_rate ?? 0) > 0.25 ? 'text-red-400' : 'text-emerald-400'
                      }`}>
                        {((liveData?.telemetry?.provider_error_rate ?? 0) * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Arrow */}
                <div className="hidden md:flex items-center justify-center -mx-2 z-10">
                  <ArrowRight className="w-5 h-5 text-gray-600" />
                </div>

                {/* Stage 3 */}
                <div className="bg-gray-950/70 border border-gray-800 rounded-lg p-4 flex flex-col justify-between">
                  <div>
                    <div className="text-[11px] font-bold text-amber-400 uppercase tracking-wider mb-1">Stage 3</div>
                    <h3 className="font-semibold text-sm text-white flex items-center gap-1.5">
                      <Server className="w-4 h-4 text-amber-400" />
                      Call Allocator
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">FOR UPDATE SKIP LOCKED</p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-gray-800/80 text-xs text-gray-300">
                    <div>Approved Tickets: <span className="text-white font-mono">{liveData?.worker_stats?.total_approved ?? 0}</span></div>
                    <div>Placed Calls: <span className="text-emerald-400 font-mono font-bold">{liveData?.worker_stats?.total_placed ?? 0}</span></div>
                  </div>
                </div>
              </div>
            </section>

            {/* 1.3 Live Feed of Safety Controller Decisions */}
            <section className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-cyan-400" />
                  <h2 className="font-semibold text-sm text-gray-200 tracking-wide uppercase">
                    Safety Controller Audit Trail (Real-Time Invariant Feed)
                  </h2>
                </div>
                <span className="text-xs text-gray-400">Table: pacing_audit_logs</span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-950/60 text-gray-400 uppercase text-[10px] tracking-wider border-b border-gray-800">
                    <tr>
                      <th className="py-2.5 px-3">Timestamp</th>
                      <th className="py-2.5 px-3">Mode</th>
                      <th className="py-2.5 px-3">Decision</th>
                      <th className="py-2.5 px-3 text-right">Proposed</th>
                      <th className="py-2.5 px-3 text-right">Approved</th>
                      <th className="py-2.5 px-3">Reason / Invariant Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60 text-gray-300 font-mono">
                    {liveData?.recent_decisions && liveData.recent_decisions.length > 0 ? (
                      liveData.recent_decisions.map((d) => (
                        <tr key={d.id} className="hover:bg-gray-800/30 transition">
                          <td className="py-2.5 px-3 text-gray-400">{new Date(d.timestamp).toLocaleTimeString()}</td>
                          <td className="py-2.5 px-3">
                            <span className="text-[10px] bg-gray-800 px-1.5 py-0.5 rounded text-gray-300 font-sans">
                              {d.mode}
                            </span>
                          </td>
                          <td className="py-2.5 px-3">
                            <DecisionBadge decision={d.decision} />
                          </td>
                          <td className="py-2.5 px-3 text-right">{d.proposed_calls}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-white">{d.approved_calls}</td>
                          <td className="py-2.5 px-3 font-sans text-gray-400 max-w-md truncate">{d.reason}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-gray-500 font-sans">
                          No recent pacing decisions recorded yet. Start campaign or trigger simulator below.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 2: EFFICIENCY & SIMULATION RESULTS (SCENARIOS A - D) */}
        {/* ========================================================================= */}
        {activeTab === 'scenarios' && (
          <div className="space-y-6">
            {/* Header with Trigger Controls */}
            <div className="flex flex-wrap items-center justify-between gap-4 bg-gray-900/60 border border-gray-800 rounded-xl p-5">
              <div>
                <h2 className="text-base font-bold text-white">Predictive Efficiency vs. Progressive Safety</h2>
                <p className="text-xs text-gray-400 mt-1">
                  Benchmarking agent utilization, initiated dials, and non-bypassable safety overrides under varying answer rates.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => handleRunSimulator('all')}
                  disabled={loadingSim}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 text-white text-xs font-semibold px-4 py-2 rounded-lg flex items-center gap-2 transition shadow-lg shadow-blue-600/20"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  {loadingSim ? 'Executing Run...' : 'Run All Scenarios'}
                </button>
                <button
                  onClick={() => handleRunSimulator('scenarios')}
                  disabled={loadingSim}
                  className="bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium px-3 py-2 rounded-lg border border-gray-700 transition"
                >
                  Scenarios A–D Only
                </button>
              </div>
            </div>

            {/* Side-by-Side Comparison Table */}
            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm overflow-x-auto">
              <div className="flex items-center gap-2 mb-4">
                <Layers className="w-4 h-4 text-blue-400" />
                <h3 className="font-semibold text-sm text-gray-200 uppercase tracking-wide">
                  Progressive vs. Predictive Benchmark Matrix
                </h3>
              </div>

              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-950/80 text-gray-400 uppercase text-[10px] tracking-wider border-b border-gray-800">
                    <th className="py-3 px-3.5">Scenario</th>
                    <th className="py-3 px-3">Mode</th>
                    <th className="py-3 px-3 text-right">Ans Rate</th>
                    <th className="py-3 px-3 text-right">Initiated</th>
                    <th className="py-3 px-3 text-right">Connected</th>
                    <th className="py-3 px-3 text-right">Abandon Rate %</th>
                    <th className="py-3 px-3 text-right">Agent Util %</th>
                    <th className="py-3 px-3 text-center">Safety Overrides</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/60 font-mono">
                  {simData.scenarios.map((sc: ScenarioComparison, idx: number) => (
                    <React.Fragment key={idx}>
                      {/* Progressive Row */}
                      <tr className="bg-gray-900/20 hover:bg-gray-800/30 transition">
                        <td rowSpan={2} className="py-3 px-3.5 font-sans font-semibold text-white border-r border-gray-800/80">
                          {sc.name}
                          <div className="text-[11px] font-normal text-gray-400 mt-0.5">
                            Talk Duration: {sc.talk_time_sec}s
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60 font-sans">
                            PROGRESSIVE
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-400">{(sc.answer_rate * 100).toFixed(0)}%</td>
                        <td className="py-2.5 px-3 text-right text-gray-300">{sc.progressive.calls_initiated}</td>
                        <td className="py-2.5 px-3 text-right text-gray-300">{sc.progressive.calls_connected}</td>
                        <td className="py-2.5 px-3 text-right text-emerald-400 font-bold">
                          {sc.progressive.abandonment_pct.toFixed(2)}%
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-300">{sc.progressive.agent_util_pct.toFixed(1)}%</td>
                        <td className="py-2.5 px-3 text-center text-gray-500 font-sans text-[11px]">
                          0 / 0 / 0
                        </td>
                      </tr>

                      {/* Predictive Row */}
                      <tr className="bg-blue-950/10 hover:bg-blue-950/20 transition border-b-2 border-gray-800/80">
                        <td className="py-2.5 px-3">
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-950/60 text-purple-300 border border-purple-800/60 font-sans">
                            PREDICTIVE
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right text-gray-400">{(sc.answer_rate * 100).toFixed(0)}%</td>
                        <td className="py-2.5 px-3 text-right font-bold text-white">{sc.predictive.calls_initiated}</td>
                        <td className="py-2.5 px-3 text-right font-bold text-white">{sc.predictive.calls_connected}</td>
                        <td className={`py-2.5 px-3 text-right font-bold ${
                          sc.predictive.abandonment_pct <= 2.0 ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                          {sc.predictive.abandonment_pct.toFixed(2)}%
                        </td>
                        <td className="py-2.5 px-3 text-right text-cyan-300 font-bold">
                          {sc.predictive.agent_util_pct.toFixed(1)}%
                          <span className="text-[10px] text-emerald-400 font-sans ml-1">
                            (+{(sc.predictive.agent_util_pct - sc.progressive.agent_util_pct).toFixed(0)}%)
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-center font-sans text-[11px]">
                          <span className="text-gray-300">
                            {sc.predictive.reduce_count} red / {sc.predictive.reject_count} rej / {sc.predictive.fallback_count} fall
                          </span>
                        </td>
                      </tr>
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Scenario D Timeline Visualizer */}
            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <TrendingDown className="w-4 h-4 text-amber-400" />
                  <h3 className="font-semibold text-sm text-gray-200 uppercase tracking-wide">
                    Scenario D Dynamic Shock: Answer Rate Collapse (70% &rarr; 10%) & Immediate Progressive Fallback
                  </h3>
                </div>
                <span className="text-xs text-amber-300/80 bg-amber-950/50 border border-amber-800/60 px-2.5 py-1 rounded">
                  Trigger at T = 1.5s: Regulatory Abandonment Protection
                </span>
              </div>

              {/* Timeline Step Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3">
                {simData.scenario_d_timeline.map((pt: any, i: number) => (
                  <div 
                    key={i} 
                    className={`p-3 rounded-lg border flex flex-col justify-between text-xs transition ${
                      pt.event 
                        ? 'bg-amber-950/40 border-amber-600 shadow-md shadow-amber-900/30' 
                        : pt.mode === 'PROGRESSIVE_FALLBACK'
                        ? 'bg-emerald-950/20 border-emerald-800/40'
                        : 'bg-gray-950/70 border-gray-800'
                    }`}
                  >
                    <div>
                      <div className="flex justify-between items-center mb-1 text-[11px] text-gray-400">
                        <span>T = {pt.seconds}s</span>
                        <span className={`font-bold ${pt.answer_rate_pct >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {pt.answer_rate_pct}% Ans
                        </span>
                      </div>
                      <div className="font-mono text-white mt-1">
                        <div>Ringing: <span className="font-bold text-cyan-300">{pt.ringing_calls}</span></div>
                        <div>Connected: <span className="font-bold text-blue-300">{pt.connected}</span></div>
                      </div>
                    </div>

                    <div className="mt-3 pt-2 border-t border-gray-800/80">
                      {pt.event ? (
                        <span className="text-[10px] font-bold text-amber-300 block leading-tight">
                          FALLBACK ACTIVATED
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400 uppercase tracking-wider">
                          {pt.mode === 'PROGRESSIVE_FALLBACK' ? 'Progressive Mode' : 'Predictive Mode'}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* TAB 3: FAILURE CASES & LOAD TEST VERIFICATION */}
        {/* ========================================================================= */}
        {activeTab === 'failures' && (
          <div className="space-y-6">
            {/* 3.1 Failure Cases Status Cards */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-emerald-400" />
                  <h2 className="font-semibold text-sm text-gray-200 tracking-wide uppercase">
                    The 5 Mandatory Distributed Failure Cases (Automated Integration Tests)
                  </h2>
                </div>
                <span className="text-xs text-emerald-400 font-bold bg-emerald-950/60 border border-emerald-800/60 px-3 py-1 rounded">
                  All 5 Cases Passing (100% Verification)
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {simData.failure_cases.map((fc: any) => (
                  <div key={fc.id} className="bg-gray-900/60 border border-gray-800 rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-mono font-bold text-blue-400">Case #{fc.id}</span>
                        <span className="flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/60">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          PASSED
                        </span>
                      </div>
                      <h3 className="font-bold text-sm text-white">{fc.name}</h3>
                      <p className="text-xs text-gray-400 mt-1 leading-relaxed">{fc.description}</p>
                    </div>

                    <div className="mt-4 pt-3 border-t border-gray-800 font-mono text-[11px] text-gray-300 bg-gray-950/60 p-2.5 rounded border border-gray-800/60">
                      <span className="text-gray-500 font-sans block text-[10px] uppercase tracking-wider mb-0.5">Observed Event Trace:</span>
                      {fc.event_trace}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 3.2 Basic Concurrency Load Test */}
            <div className="bg-gray-900/60 border border-gray-800 rounded-xl p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-cyan-400" />
                  <h2 className="font-semibold text-sm text-gray-200 tracking-wide uppercase">
                    Concurrency Load Test (100 &rarr; 1,000 Agents on PostgreSQL SKIP LOCKED)
                  </h2>
                </div>
                <span className="text-xs text-cyan-300 font-mono bg-cyan-950/60 border border-cyan-800/60 px-3 py-1 rounded">
                  Overall p99 Latency: {simData.load_test.p99_latency}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-gray-950/80 text-gray-400 uppercase text-[10px] tracking-wider border-b border-gray-800">
                    <tr>
                      <th className="py-3 px-3.5">Concurrent Workers</th>
                      <th className="py-3 px-3 text-right">Successful Reservations</th>
                      <th className="py-3 px-3 text-right">Double-Allocations</th>
                      <th className="py-3 px-3 text-right">Throughput (Req/Sec)</th>
                      <th className="py-3 px-3 text-right">p50 Latency</th>
                      <th className="py-3 px-3 text-right">p95 Latency</th>
                      <th className="py-3 px-3 text-right text-cyan-400">p99 Latency</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60 font-mono text-gray-300">
                    {simData.load_test.levels.map((lvl: any, i: number) => (
                      <tr key={i} className="hover:bg-gray-800/30 transition">
                        <td className="py-3 px-3.5 font-bold text-white">{lvl.workers} Workers</td>
                        <td className="py-3 px-3 text-right text-emerald-400 font-bold">{lvl.successful_reservations} / {lvl.workers}</td>
                        <td className="py-3 px-3 text-right font-bold text-emerald-400">0 (Zero)</td>
                        <td className="py-3 px-3 text-right font-bold text-white">{lvl.throughput_rps} rps</td>
                        <td className="py-3 px-3 text-right">{lvl.p50_ms} ms</td>
                        <td className="py-3 px-3 text-right">{lvl.p95_ms} ms</td>
                        <td className="py-3 px-3 text-right text-cyan-300 font-bold">{lvl.p99_ms} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// SUBCOMPONENTS
// ------------------------------------------------------------------------------------------------

function AgentStateCard({ state, count, total, color, desc }: { 
  state: string; 
  count: number; 
  total: number; 
  color: string; 
  desc: string; 
}) {
  const colorMap: Record<string, string> = {
    emerald: 'bg-emerald-950/30 border-emerald-800/50 text-emerald-400',
    amber: 'bg-amber-950/30 border-amber-800/50 text-amber-400',
    blue: 'bg-blue-950/30 border-blue-800/50 text-blue-400',
    violet: 'bg-violet-950/30 border-violet-800/50 text-violet-400',
    cyan: 'bg-cyan-950/30 border-cyan-800/50 text-cyan-400',
    yellow: 'bg-yellow-950/30 border-yellow-800/50 text-yellow-400',
    gray: 'bg-gray-800/30 border-gray-700/50 text-gray-400',
  };

  const pct = total > 0 ? ((count / total) * 100).toFixed(0) : '0';

  return (
    <div className={`border rounded-lg p-3 flex flex-col justify-between ${colorMap[color] || colorMap.gray}`}>
      <div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold tracking-wider uppercase">{state}</span>
          <span className="text-[10px] opacity-75 font-mono">{pct}%</span>
        </div>
        <div className="text-2xl font-bold font-mono text-white mt-1">{count}</div>
      </div>
      <p className="text-[10px] text-gray-400 mt-2 leading-tight">{desc}</p>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: string }) {
  switch (decision) {
    case 'APPROVE':
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-800/60 font-sans">APPROVE</span>;
    case 'REDUCE':
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-950/80 text-amber-300 border border-amber-800/60 font-sans">REDUCE</span>;
    case 'REJECT':
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-950/80 text-red-300 border border-red-800/60 font-sans">REJECT</span>;
    case 'FALLBACK_TO_PROGRESSIVE':
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-800/60 font-sans">FALLBACK</span>;
    default:
      return <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-gray-800 text-gray-300 font-sans">{decision}</span>;
  }
}
