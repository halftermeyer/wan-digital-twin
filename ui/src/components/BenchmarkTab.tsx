import { useState, useCallback, useMemo } from "react";
import { FilledButton, Banner } from "@neo4j-ndl/react";
import { runBenchmarkSuite, BENCH_QUERY_TIMEOUT_S, type BenchmarkStep } from "../lib/benchmark";

const PRESETS = [
  { label: "44 routers (this demo)", n: 44, core: 12 },
  { label: "400 routers, small hub set", n: 400, core: 30 },
  { label: "400 routers, proportional CORE (worst case)", n: 400, core: 108 },
  { label: "1,200 routers, 60 CORE — Tier-1 global bank (estimate)", n: 1200, core: 60 },
  { label: "1000 routers, small hub set", n: 1000, core: 40 },
  { label: "5000 routers, 200 CORE (quadratic cliff)", n: 5000, core: 200 },
];

// Calibrated from measured runs at 5000 routers: ms/pair scales ~linearly with both
// pairs and total graph size (BFS-per-pair is O(V+E)). 190 pairs -> 1.3s, 1225 -> 6.0s,
// 4950 -> 23.5s at n=5000 all fit estimatedSeconds = pairs * (n/1000) / 1000 closely.
function estimatePairsSeconds(nPairs: number, nRouters: number): number {
  return (nPairs * (nRouters / 1000)) / 1000;
}

export default function BenchmarkTab() {
  const [n, setN] = useState(400);
  const [core, setCore] = useState(30);
  const [steps, setSteps] = useState<BenchmarkStep[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nPairs, setNPairs] = useState<number | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setSteps([]);
    setNPairs(null);
    try {
      const { nPairs: pairs } = await runBenchmarkSuite(n, core, (step) => {
        setSteps((prev) => [...prev, step]);
      });
      setNPairs(pairs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [n, core]);

  const maxMs = useMemo(() => Math.max(1, ...steps.map((s) => s.ms)), [steps]);
  const totalMs = useMemo(() => steps.reduce((s, x) => s + x.ms, 0), [steps]);
  const criticalPairStep = steps.find((s) => s.label.startsWith("Critical-pair"));
  const projectedPairs = useMemo(() => (core * (core - 1)) / 2, [core]);
  const estimatedPairsS = useMemo(() => estimatePairsSeconds(projectedPairs, n), [projectedPairs, n]);

  return (
    <div>
      <div className="card">
        <h3>Does this scale? — live benchmark</h3>
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          Generates a synthetic router graph of any size in an <strong>isolated "benchmark"
          database</strong> — it never touches the live topology — then times the same analyses
          used throughout this demo: blast radius, GDS <code>articulationPoints</code>/
          <code>bridges</code>, Yen's k-shortest-paths, and the exhaustive critical-pair check
          across every CORE router combination.
        </p>
        <p style={{ color: "#666", fontSize: 13, margin: "8px 0 0" }}>
          That last check is the one to watch: testing every pair of CORE routers is
          quadratic in the size of the backbone/hub set. It stays interactive as long as the
          hub set stays small — which is also good network design — and the benchmark shows
          exactly where that line is for a given topology size, with a live time estimate
          before you run it.
        </p>
      </div>

      <div className="card">
        <div className="scenario-controls">
          <label>
            Preset:
            <select
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p) {
                  setN(p.n);
                  setCore(p.core);
                }
              }}
              defaultValue=""
            >
              <option value="" disabled>
                choose…
              </option>
              {PRESETS.map((p, i) => (
                <option key={i} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Routers:
            <input
              type="number"
              min={20}
              max={5000}
              value={n}
              onChange={(e) => setN(Math.max(20, Math.min(5000, Number(e.target.value) || 0)))}
              style={{ width: 90, padding: "6px 10px", border: "1px solid #d0d8e8", borderRadius: 6 }}
            />
          </label>
          <label>
            CORE:
            <input
              type="number"
              min={2}
              max={n}
              value={core}
              onChange={(e) => setCore(Math.max(2, Math.min(n, Number(e.target.value) || 0)))}
              style={{ width: 90, padding: "6px 10px", border: "1px solid #d0d8e8", borderRadius: 6 }}
            />
          </label>
          <FilledButton size="small" onClick={run} isLoading={running} isDisabled={running}>
            Run Benchmark
          </FilledButton>
        </div>
        {estimatedPairsS > 3 && (
          <Banner variant={estimatedPairsS > BENCH_QUERY_TIMEOUT_S ? "danger" : "warning"}>
            <span>
              C({core},2) = {projectedPairs.toLocaleString()} pairs over {n.toLocaleString()} routers
              — critical-pair enumeration is <code>O(n_core² × graph size)</code>, estimated ≈
              {estimatedPairsS < 1 ? "<1" : Math.round(estimatedPairsS).toLocaleString()}s.{" "}
              {estimatedPairsS > BENCH_QUERY_TIMEOUT_S
                ? `Longer than the ${BENCH_QUERY_TIMEOUT_S}s query timeout — that step will likely fail with a clean timeout, which is the expected outcome at this scale, not a bug.`
                : "Keep the hub/CORE set small for a live-clickable demo; this is why."}
            </span>
          </Banner>
        )}
        {error && <Banner variant="danger">{error}</Banner>}
      </div>

      {steps.length > 0 && (
        <div className="card">
          <h3>Results — {n} routers, {core} CORE</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Time</th>
                <th>Rows / detail</th>
                <th style={{ width: "35%" }} />
              </tr>
            </thead>
            <tbody>
              {steps.map((s, i) => (
                <tr key={i}>
                  <td>{s.label}</td>
                  <td style={{ fontFamily: "monospace" }}>
                    {s.rows === -1 ? <span className="status-fail">{s.ms}ms</span> : `${s.ms}ms`}
                  </td>
                  <td style={{ color: s.rows === -1 ? "#c62828" : "#666", fontSize: 12 }}>
                    {s.detail ?? s.rows}
                  </td>
                  <td>
                    <div
                      style={{
                        height: 10,
                        borderRadius: 4,
                        background: s.rows === -1 ? "#c62828" : "#006fd6",
                        width: `${Math.max(2, (s.ms / maxMs) * 100)}%`,
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!running && (
            <div className="scenario-summary" style={{ marginTop: 12 }}>
              <div className="scenario-stat safe">
                <div className="stat-number">{totalMs}ms</div>
                <div className="stat-label">Total pipeline time</div>
              </div>
              {criticalPairStep && (
                <div className={`scenario-stat ${criticalPairStep.ms > 3000 ? "warn" : "safe"}`}>
                  <div className="stat-number">{criticalPairStep.ms}ms</div>
                  <div className="stat-label">
                    Critical-pair enumeration ({nPairs?.toLocaleString()} pairs)
                  </div>
                </div>
              )}
            </div>
          )}
          {!running && (
            <Banner variant={totalMs < 5000 ? "success" : "warning"}>
              {totalMs < 2000
                ? `Every query pattern the demo uses stays comfortably interactive at ${n} routers.`
                : `Still runs end-to-end at ${n} routers, but the critical-pair enumeration is the query to watch as CORE count grows — keep the hub/CORE set small rather than scaling it proportionally with total router count.`}
            </Banner>
          )}
        </div>
      )}
    </div>
  );
}
