import { useState, useEffect, useCallback } from "react";
import { LoadingSpinner, Banner } from "@neo4j-ndl/react";
import NetworkGraph from "./NetworkGraph";
import {
  getOverview,
  getMediumBreakdown,
  getCities,
  getCityRouters,
  getRouterNeighbors,
  getRouterBgpPeers,
  getTopologyGraph,
  type OverviewRow,
  type MediumRow,
  type CityRow,
  type RouterRow,
  type TopologyNode,
  type TopologyLink,
} from "../lib/queries";

export default function ExploreTab() {
  const [overview, setOverview] = useState<OverviewRow[]>([]);
  const [medium, setMedium] = useState<MediumRow[]>([]);
  const [cities, setCities] = useState<CityRow[]>([]);
  const [graph, setGraph] = useState<{ nodes: TopologyNode[]; links: TopologyLink[] }>({ nodes: [], links: [] });
  const [selectedCity, setSelectedCity] = useState<CityRow | null>(null);
  const [routers, setRouters] = useState<RouterRow[]>([]);
  const [selectedRouter, setSelectedRouter] = useState<string | null>(null);
  const [neighbors, setNeighbors] = useState<{ hostname: string; city: string; latency_ms: number }[]>([]);
  const [bgpPeers, setBgpPeers] = useState<{ peer: string; type: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getOverview(), getMediumBreakdown(), getCities(), getTopologyGraph()])
      .then(([ov, med, c, g]) => {
        setOverview(ov);
        setMedium(med);
        setCities(c);
        setGraph(g);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const inspectCity = useCallback(async (city: CityRow) => {
    setSelectedCity(city);
    setSelectedRouter(null);
    setNeighbors([]);
    setBgpPeers([]);
    setRouters(await getCityRouters(city.code));
  }, []);

  const inspectRouter = useCallback(async (hostname: string) => {
    setSelectedRouter(hostname);
    setNeighbors(await getRouterNeighbors(hostname));
    setBgpPeers(await getRouterBgpPeers(hostname));
  }, []);

  if (loading) {
    return (
      <div className="loading-container">
        <LoadingSpinner size="large" />
        Connecting to Neo4j (database "wan")...
      </div>
    );
  }

  if (error) {
    return <Banner variant="danger">{error}</Banner>;
  }

  const totalRouters = overview.reduce((s, r) => s + r.routers, 0);

  return (
    <div>
      <div className="card-row">
        <div className="card">
          <h3>Routers by region &amp; role ({totalRouters} total)</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Role</th>
                <th>Routers</th>
              </tr>
            </thead>
            <tbody>
              {overview.map((r, i) => (
                <tr key={i}>
                  <td>{r.region}</td>
                  <td>
                    <span className="chip">{r.role}</span>
                  </td>
                  <td>{r.routers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Physical links by medium</h3>
          <table className="data-table">
            <thead>
              <tr>
                <th>Medium</th>
                <th>Links</th>
                <th>Capacity (Gbps)</th>
              </tr>
            </thead>
            <tbody>
              {medium.map((m, i) => (
                <tr key={i}>
                  <td>{m.medium}</td>
                  <td>{m.links}</td>
                  <td>{m.total_capacity_gbps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Topology — 44 routers across 20 cities</h3>
        <NetworkGraph
          nodes={graph.nodes}
          links={graph.links}
          failed={selectedRouter ? [selectedRouter] : []}
        />
      </div>

      <div className="card-row">
        <div className="card" style={{ flex: "0 0 260px" }}>
          <h3>Cities ({cities.length})</h3>
          <div style={{ maxHeight: 420, overflow: "auto" }}>
            {cities.map((c) => (
              <div
                key={c.code}
                onClick={() => inspectCity(c)}
                style={{
                  padding: "6px 10px",
                  cursor: "pointer",
                  borderRadius: 4,
                  background: selectedCity?.code === c.code ? "#e3f2fd" : "transparent",
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 13,
                }}
              >
                <span>
                  <strong>{c.code}</strong> — {c.name}
                </span>
                <span style={{ color: "#999" }}>{c.routerCount}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card" style={{ flex: 1 }}>
          <h3>
            {selectedCity ? `Routers in ${selectedCity.name} (${selectedCity.code})` : "Select a city"}
          </h3>
          {selectedCity && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Hostname</th>
                  <th>Role</th>
                  <th>OS</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {routers.map((r) => (
                  <tr
                    key={r.hostname}
                    onClick={() => inspectRouter(r.hostname)}
                    style={{
                      cursor: "pointer",
                      background: selectedRouter === r.hostname ? "#e3f2fd" : undefined,
                    }}
                  >
                    <td>{r.hostname}</td>
                    <td>
                      <span className="chip">{r.role}</span>
                    </td>
                    <td>{r.os}</td>
                    <td>
                      <span className={r.status === "UP" ? "status-pass" : "status-fail"}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selectedRouter && (
          <div className="card" style={{ flex: 1 }}>
            <h3>{selectedRouter}</h3>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#666" }}>
              CONNECTED_TO neighbors ({neighbors.length})
            </div>
            <table className="data-table">
              <tbody>
                {neighbors.map((n, i) => (
                  <tr key={i}>
                    <td>{n.hostname}</td>
                    <td>{n.city}</td>
                    <td>{n.latency_ms} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ fontSize: 13, fontWeight: 600, margin: "12px 0 6px", color: "#666" }}>
              BGP sessions ({bgpPeers.length})
            </div>
            <table className="data-table">
              <tbody>
                {bgpPeers.map((p, i) => (
                  <tr key={i}>
                    <td>{p.peer}</td>
                    <td>
                      <span className="chip">{p.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
