import { useState, useEffect, useCallback } from "react";
import { LoadingSpinner, Banner } from "@neo4j-ndl/react";
import NetworkGraph from "./NetworkGraph";
import {
  getIntents,
  getIntentPath,
  getTopologyGraph,
  type IntentRow,
  type IntentPathRow,
  type TopologyNode,
  type TopologyLink,
} from "../lib/queries";

function StatusChip({ status }: { status: string }) {
  if (status === "PASS") return <span className="status-pass">PASS</span>;
  if (status === "FAIL") return <span className="status-fail">FAIL</span>;
  return <span className="status-warn">{status}</span>;
}

export default function FlowTab() {
  const [intents, setIntents] = useState<IntentRow[]>([]);
  const [graph, setGraph] = useState<{ nodes: TopologyNode[]; links: TopologyLink[] }>({ nodes: [], links: [] });
  const [selected, setSelected] = useState<IntentRow | null>(null);
  const [path, setPath] = useState<IntentPathRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getIntents(), getTopologyGraph()])
      .then(([i, g]) => {
        setIntents(i);
        setGraph(g);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const inspect = useCallback(async (intent: IntentRow) => {
    setSelected(intent);
    setPath(await getIntentPath(intent.id));
  }, []);

  if (loading) {
    return (
      <div className="loading-container">
        <LoadingSpinner size="large" />
        Loading Intent / OperationalPath / Validation layer...
      </div>
    );
  }

  if (error) return <Banner variant="danger">{error}</Banner>;

  const passCount = intents.filter((i) => i.validation_status === "PASS").length;
  const violations = intents.filter((i) => i.violation_type);

  return (
    <div>
      <div className="card">
        <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span>What this tab is</span>
        </h3>
        <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
          The <code>Intent → OperationalPath → ValidationResult → SecurityViolation</code>{" "}
          layer from the network digital twin target schema: <strong>Batfish calcule, Neo4j mémorise et
          explique</strong> — a resolved path is a small persisted object (hop list, latency,
          health), never the raw routing table. On this synthetic topology the resolver is the
          graph's own shortest-path engine; on a real-config-backed deployment the same
          schema is populated by Batfish reachability/traceroute questions.
        </p>
      </div>

      <div className="card-row">
        <div className="card">
          <h3>Intents ({intents.length})</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Consumer</th>
                <th>Src → Dst</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {intents.map((i) => (
                <tr
                  key={i.id}
                  onClick={() => inspect(i)}
                  style={{ cursor: "pointer", background: selected?.id === i.id ? "#e3f2fd" : undefined }}
                >
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{i.id}</td>
                  <td>{i.name}</td>
                  <td>{i.consumer_label ?? "—"}</td>
                  <td>
                    {i.src_city} &rarr; {i.dst_city}
                  </td>
                  <td>
                    <span className="chip">{i.policy_type}</span>
                  </td>
                  <td>
                    <StatusChip status={i.validation_status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="scenario-summary" style={{ marginTop: 12 }}>
            <div className="scenario-stat safe">
              <div className="stat-number">{passCount}</div>
              <div className="stat-label">Intents PASS</div>
            </div>
            <div className="scenario-stat fail">
              <div className="stat-number">{intents.length - passCount}</div>
              <div className="stat-label">Intents FAIL</div>
            </div>
            <div className="scenario-stat warn">
              <div className="stat-number">{violations.length}</div>
              <div className="stat-label">SecurityViolations</div>
            </div>
          </div>
        </div>
      </div>

      {selected && (
        <div className="card">
          <h3>
            {selected.id} — {selected.name}
          </h3>
          <p className="scenario-desc" style={{ marginBottom: 12 }}>
            {selected.protocol}
            {selected.port ? `:${selected.port}` : ""} · expected{" "}
            <code>{selected.expected_result}</code> · observed{" "}
            <code>{selected.observed_result}</code> · {selected.hop_count} hops
            {selected.latency_ms != null ? `, ${selected.latency_ms}ms` : ""}
          </p>

          {selected.violation_type && (
            <Banner variant="danger">
              <span>
                <strong>SecurityViolation ({selected.violation_type}):</strong> {selected.violation_detail}
              </span>
            </Banner>
          )}
          {!selected.violation_type && selected.validation_status === "PASS" && (
            <Banner variant="success">Intent validated — resolved path satisfies the policy.</Banner>
          )}

          <table className="data-table" style={{ marginTop: 12 }}>
            <thead>
              <tr>
                <th>Hop</th>
                <th>Router</th>
                <th>Role</th>
                <th>City</th>
                <th>Region</th>
              </tr>
            </thead>
            <tbody>
              {path.map((h) => (
                <tr key={h.hop}>
                  <td>{h.hop}</td>
                  <td>{h.hostname}</td>
                  <td>
                    <span className="chip">{h.role}</span>
                  </td>
                  <td>{h.city}</td>
                  <td>{h.region}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 12 }}>
            <NetworkGraph nodes={graph.nodes} links={graph.links} highlightPath={path.map((h) => h.hostname)} />
          </div>
        </div>
      )}
    </div>
  );
}
