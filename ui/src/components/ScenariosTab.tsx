import { useState, useEffect, useCallback } from "react";
import { FilledButton, OutlinedButton, Banner } from "@neo4j-ndl/react";
import NetworkGraph from "./NetworkGraph";
import {
  getAllRouters,
  getCities,
  getTopologyGraph,
  articulationPoints,
  bridges,
  blastRadius,
  criticalCorePairs,
  shortestPath,
  yensPaths,
  createIncident,
  getIncidentImpact,
  resetIncidents,
  hasActiveIncident,
  serviceImpactAnalysis,
  type RouterRow,
  type CityRow,
  type TopologyNode,
  type TopologyLink,
  type SpofRow,
  type BridgeRow,
  type BlastRadiusRow,
  type CriticalPairRow,
  type ShortestPathRow,
  type YensRow,
  type ServiceImpactRow,
} from "../lib/queries";

// ─── Maximizable scenario wrapper (same pattern as the reference demo) ───

function ScenarioCard({ children }: { children: React.ReactNode }) {
  const [maximized, setMaximized] = useState(false);
  return (
    <>
      {maximized && <div className="scenario-backdrop" onClick={() => setMaximized(false)} />}
      <div className={`scenario-card ${maximized ? "maximized" : ""}`}>
        <button
          className="scenario-maximize-btn"
          onClick={() => setMaximized(!maximized)}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? "✖" : "⛶"}
        </button>
        {children}
      </div>
    </>
  );
}

function ScenarioHeader({ n, title, desc }: { n: number; title: string; desc: React.ReactNode }) {
  return (
    <div className="scenario-header">
      <div className="scenario-number">{n}</div>
      <div>
        <h3>{title}</h3>
        <p className="scenario-desc">{desc}</p>
      </div>
    </div>
  );
}

// ─── Act 1: SPOF — articulation points & bridges (Q3) ──────────

function Act1Spof({ graph }: { graph: { nodes: TopologyNode[]; links: TopologyLink[] } }) {
  const [aps, setAps] = useState<SpofRow[] | null>(null);
  const [brs, setBrs] = useState<BridgeRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setAps(await articulationPoints());
      setBrs(await bridges());
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={1}
        title="Where are your SPOFs? — Articulation Points & Bridges"
        desc={
          <>
            GDS <code>gds.articulationPoints</code> and <code>gds.bridges</code> run on the
            derived <code>CONNECTED_TO</code> layer. No one has to "know" the network to find
            its fragilities — the graph algorithm finds them exhaustively.
          </>
        }
      />
      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Run GDS Analysis
        </FilledButton>
      </div>
      {aps && (
        <div className="scenario-results">
          <Banner variant={aps.length > 0 ? "warning" : "success"}>
            <span>
              <strong>{aps.length}</strong> articulation point(s): {aps.map((a) => a.spof_router).join(", ") || "none"}.{" "}
              <strong>{brs?.length ?? 0}</strong> bridge(s): {brs?.map((b) => `${b.endpoint_a}↔${b.endpoint_b}`).join(", ") || "none"}.
            </span>
          </Banner>
          <NetworkGraph nodes={graph.nodes} links={graph.links} failed={aps.map((a) => a.spof_router)} />
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 2: Blast radius — single router failure (Q2) ──────────

function Act2BlastRadius({
  graph,
  routers,
}: {
  graph: { nodes: TopologyNode[]; links: TopologyLink[] };
  routers: RouterRow[];
}) {
  const coreRouters = routers.filter((r) => r.role === "CORE");
  const [failed, setFailed] = useState("PAR-CORE-01");
  const [result, setResult] = useState<BlastRadiusRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await blastRadius([failed]));
    } finally {
      setLoading(false);
    }
  }, [failed]);

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={2}
        title="Blast Radius — the money query"
        desc={
          <>
            Pick a CORE router. Which cities can no longer reach the Paris HQ cores if it fails?
            Try <code>PAR-CORE-01</code> — Johannesburg is single-homed to it.
          </>
        }
      />
      <div className="scenario-controls">
        <label>
          Failed router:
          <select value={failed} onChange={(e) => setFailed(e.target.value)}>
            {coreRouters.map((r) => (
              <option key={r.hostname} value={r.hostname}>
                {r.hostname}
              </option>
            ))}
          </select>
        </label>
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Run Blast Radius (Q2)
        </FilledButton>
      </div>
      {result && (
        <div className="scenario-results">
          {result.length === 0 ? (
            <Banner variant="success">No city loses reachability to HQ — this failure is absorbed.</Banner>
          ) : (
            <Banner variant="danger">
              <span>
                <strong>{result.length}</strong> city(ies) isolated:{" "}
                {result.map((r) => r.isolated_city).join(", ")}.
              </span>
            </Banner>
          )}
          <NetworkGraph
            nodes={graph.nodes}
            links={graph.links}
            failed={[failed]}
            isolatedCities={result.map((r) => r.isolated_city)}
          />
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 3: Double failure what-if + critical pairs (Q4) ───────

function Act3DoubleFailure({ graph }: { graph: { nodes: TopologyNode[]; links: TopologyLink[] } }) {
  const [result, setResult] = useState<BlastRadiusRow[] | null>(null);
  const [pairs, setPairs] = useState<CriticalPairRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pairsLoading, setPairsLoading] = useState(false);
  const FAILED = ["NYC-CORE-01", "NYC-CORE-02"];

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await blastRadius(FAILED));
    } finally {
      setLoading(false);
    }
  }, []);

  const runPairs = useCallback(async () => {
    setPairsLoading(true);
    try {
      setPairs(await criticalCorePairs());
    } finally {
      setPairsLoading(false);
    }
  }, []);

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={3}
        title={`Double-Failure What-If — "your supervision doesn't see this"`}
        desc={
          <>
            Both NYC core routers fail simultaneously — each is individually redundant, but the
            pair is a 2-cut isolating South America. Below: every CORE pair whose{" "}
            <em>joint</em> failure isolates at least one city.
          </>
        }
      />
      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Fail NYC-CORE-01 + NYC-CORE-02
        </FilledButton>
        <OutlinedButton size="small" onClick={runPairs} isLoading={pairsLoading} isDisabled={pairsLoading}>
          Enumerate All Critical Pairs
        </OutlinedButton>
      </div>
      {result && (
        <div className="scenario-results">
          <Banner variant={result.length > 0 ? "danger" : "success"}>
            {result.length > 0
              ? `Isolated: ${result.map((r) => r.isolated_city).join(", ")}`
              : "No isolation — this failure is absorbed."}
          </Banner>
          <NetworkGraph
            nodes={graph.nodes}
            links={graph.links}
            failed={FAILED}
            isolatedCities={result.map((r) => r.isolated_city)}
          />
        </div>
      )}
      {pairs && (
        <table className="data-table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Failed CORE pair</th>
              <th>Isolated cities</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((p, i) => (
              <tr key={i}>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{p.failed_core_pair.join(" + ")}</td>
                <td>{p.isolated_cities.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ScenarioCard>
  );
}

// ─── Act 4: Path diversity (Q5) ─────────────────────────────────

function Act4PathDiversity({ graph, cities }: { graph: { nodes: TopologyNode[]; links: TopologyLink[] }; cities: CityRow[] }) {
  const [src, setSrc] = useState("LON");
  const [dst, setDst] = useState("SGP");
  const [shortest, setShortest] = useState<ShortestPathRow | null>(null);
  const [yens, setYens] = useState<YensRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setShortest(await shortestPath(src, dst));
      setYens(await yensPaths(src, dst, 3));
    } finally {
      setLoading(false);
    }
  }, [src, dst]);

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={4}
        title="Resilience — Path Diversity"
        desc={
          <>
            Exact shortest path (CYPHER 25 QPP) plus 3 alternative routes (GDS Yen's k-shortest,
            weighted by latency) between two cities.
          </>
        }
      />
      <div className="scenario-controls">
        <label>
          From:
          <select value={src} onChange={(e) => setSrc(e.target.value)}>
            {cities.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          To:
          <select value={dst} onChange={(e) => setDst(e.target.value)}>
            {cities.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Compute Paths
        </FilledButton>
      </div>
      {shortest && (
        <div className="scenario-results">
          <Banner variant="info">
            <span>
              Shortest: {shortest.hops.join(" → ")} — {shortest.total_latency_ms}ms
            </span>
          </Banner>
          {yens && (
            <table className="data-table" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Hops</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody>
                {yens.map((y) => (
                  <tr key={y.route}>
                    <td>{y.route}</td>
                    <td style={{ fontFamily: "monospace", fontSize: 12 }}>{y.hops.join(" → ")}</td>
                    <td>{y.total_latency_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <NetworkGraph nodes={graph.nodes} links={graph.links} highlightPath={shortest.hops} />
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 5: Incident RCA (Q6) ────────────────────────────────────

function Act5IncidentRca({
  graph,
  routers,
  onChange,
}: {
  graph: { nodes: TopologyNode[]; links: TopologyLink[] };
  routers: RouterRow[];
  onChange: () => void;
}) {
  const coreRouters = routers.filter((r) => r.role === "CORE");
  const [target, setTarget] = useState("PAR-CORE-01");
  const [impact, setImpact] = useState<BlastRadiusRow[] | null>(null);
  const [active, setActive] = useState(false);
  const [loading, setLoading] = useState(false);

  const declare = useCallback(async () => {
    setLoading(true);
    try {
      await createIncident(target);
      setImpact(await getIncidentImpact());
      setActive(true);
      onChange();
    } finally {
      setLoading(false);
    }
  }, [target, onChange]);

  const reset = useCallback(async () => {
    setLoading(true);
    try {
      await resetIncidents();
      setImpact(null);
      setActive(false);
      onChange();
    } finally {
      setLoading(false);
    }
  }, [onChange]);

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={5}
        title="Incident RCA — the same graph, live"
        desc={
          <>
            Declares a P1 <code>Incident</code> on a router (writes to the graph), then reuses
            the blast-radius query from the incident's <code>AFFECTS</code> edge. Topology and
            incident overlay share one model.
          </>
        }
      />
      <div className="scenario-controls">
        <label>
          Affected router:
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={active}>
            {coreRouters.map((r) => (
              <option key={r.hostname} value={r.hostname}>
                {r.hostname}
              </option>
            ))}
          </select>
        </label>
        <FilledButton size="small" onClick={declare} isLoading={loading} isDisabled={loading || active}>
          Declare P1 Incident
        </FilledButton>
        {active && (
          <OutlinedButton size="small" onClick={reset} isLoading={loading} isDisabled={loading}>
            Reset
          </OutlinedButton>
        )}
      </div>
      {impact && (
        <div className="scenario-results">
          <Banner variant={impact.length > 0 ? "danger" : "success"}>
            {impact.length > 0
              ? `Impacted cities: ${impact.map((r) => r.isolated_city).join(", ")}`
              : "No city impacted by this incident."}
          </Banner>
          <NetworkGraph
            nodes={graph.nodes}
            links={graph.links}
            failed={[target]}
            isolatedCities={impact.map((r) => r.isolated_city)}
          />
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Act 6: Service Impact Analysis (Flow layer payoff) ─────────

function Act6ServiceImpact({ routers }: { routers: RouterRow[] }) {
  const coreRouters = routers.filter((r) => r.role === "CORE");
  const [failed, setFailed] = useState<string[]>(["PAR-CORE-01"]);
  const [result, setResult] = useState<ServiceImpactRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback((hostname: string) => {
    setFailed((prev) => (prev.includes(hostname) ? prev.filter((h) => h !== hostname) : [...prev, hostname]));
  }, []);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await serviceImpactAnalysis(failed));
    } finally {
      setLoading(false);
    }
  }, [failed]);

  const broken = result?.filter((r) => !r.reachable_now) ?? [];

  return (
    <ScenarioCard>
      <ScenarioHeader
        n={6}
        title="Service Impact Analysis — the downstream payoff"
        desc={
          <>
            Pick failed routers; every business <code>Service</code>'s <code>Intent</code> is
            re-validated live (read-only what-if — the persisted baseline is untouched). This is
            "quel service est impacté ?" answered from the Flow layer, not just topology.
          </>
        }
      />
      <div className="scenario-controls" style={{ flexWrap: "wrap" }}>
        {coreRouters.map((r) => (
          <label key={r.hostname} style={{ fontSize: 13 }}>
            <input type="checkbox" checked={failed.includes(r.hostname)} onChange={() => toggle(r.hostname)} />
            {r.hostname}
          </label>
        ))}
      </div>
      <div className="scenario-controls">
        <FilledButton size="small" onClick={run} isLoading={loading} isDisabled={loading}>
          Run Service Impact Analysis
        </FilledButton>
      </div>
      {result && (
        <div className="scenario-results">
          <Banner variant={broken.length > 0 ? "danger" : "success"}>
            {broken.length > 0
              ? `${broken.length} of ${result.length} business intents lose reachability: ${broken
                  .map((b) => b.consumer_label)
                  .join(", ")}`
              : "All business intents remain reachable under this failure."}
          </Banner>
          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Service / Application</th>
                <th>Intent</th>
                <th>Path</th>
                <th>Baseline</th>
                <th>Under this failure</th>
              </tr>
            </thead>
            <tbody>
              {result.map((r) => (
                <tr key={r.intent_id}>
                  <td>{r.consumer_label}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{r.intent_id}</td>
                  <td>
                    {r.src_city} &rarr; {r.dst_city}
                  </td>
                  <td>
                    <span className={r.baseline_status === "PASS" ? "status-pass" : "status-fail"}>
                      {r.baseline_status}
                    </span>
                  </td>
                  <td>
                    <span className={r.reachable_now ? "status-pass" : "status-fail"}>
                      {r.reachable_now ? `REACHABLE (${r.latency_ms}ms)` : "UNREACHABLE"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ScenarioCard>
  );
}

// ─── Main Scenarios Tab ────────────────────────────────────────

export default function ScenariosTab() {
  const [graph, setGraph] = useState<{ nodes: TopologyNode[]; links: TopologyLink[] }>({ nodes: [], links: [] });
  const [routers, setRouters] = useState<RouterRow[]>([]);
  const [cities, setCities] = useState<CityRow[]>([]);
  const [incidentActive, setIncidentActive] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [epoch, setEpoch] = useState(0);

  const refresh = useCallback(() => {
    hasActiveIncident().then(setIncidentActive);
  }, []);

  useEffect(() => {
    Promise.all([getTopologyGraph(), getAllRouters(), getCities()]).then(([g, r, c]) => {
      setGraph(g);
      setRouters(r);
      setCities(c);
    });
    refresh();
  }, [refresh]);

  const doReset = useCallback(async () => {
    setResetting(true);
    try {
      await resetIncidents();
      setEpoch((e) => e + 1);
      refresh();
    } finally {
      setResetting(false);
    }
  }, [refresh]);

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-start", gap: 16 }}>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, color: "#0b297d" }}>Scenarios — the WAN Digital Twin demo, live</h2>
          <p style={{ color: "#666", fontSize: 14, marginTop: 4 }}>
            SPOF discovery, blast-radius and double-failure what-ifs, path diversity, incident
            RCA, and the Flow-layer payoff — Service Impact Analysis. Every result is backed by a
            Cypher statement visible in the audit drawer.
          </p>
        </div>
        {incidentActive && (
          <OutlinedButton size="small" onClick={doReset} isLoading={resetting} isDisabled={resetting}>
            Reset Demo State
          </OutlinedButton>
        )}
      </div>

      <div key={epoch}>
        <Act1Spof graph={graph} />
        <Act2BlastRadius graph={graph} routers={routers} />
        <Act3DoubleFailure graph={graph} />
        <Act4PathDiversity graph={graph} cities={cities} />
        <Act5IncidentRca graph={graph} routers={routers} onChange={refresh} />
        <Act6ServiceImpact routers={routers} />
      </div>
    </div>
  );
}
