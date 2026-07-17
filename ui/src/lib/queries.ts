import neo4j from "neo4j-driver";
import { runQuery, withGroup } from "./neo4j";

// ── Domain types ───────────────────────────────────────────────

export interface CityRow {
  code: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  routerCount: number;
}

export interface RouterRow {
  hostname: string;
  role: "CORE" | "EDGE";
  os: string;
  city: string;
  status: string;
}

export interface TopologyNode {
  hostname: string;
  role: string;
  city: string;
  region: string;
  lat: number;
  lon: number;
}

export interface TopologyLink {
  a: string;
  b: string;
  latency_ms: number;
}

export interface OverviewRow {
  region: string;
  role: string;
  routers: number;
}

export interface MediumRow {
  medium: string;
  links: number;
  total_capacity_gbps: number;
}

export interface BlastRadiusRow {
  isolated_city: string;
  name: string;
  stranded_routers: string[];
}

export interface CriticalPairRow {
  failed_core_pair: string[];
  isolated_cities: string[];
}

export interface SpofRow {
  spof_router: string;
}

export interface BridgeRow {
  endpoint_a: string;
  endpoint_b: string;
}

export interface ShortestPathRow {
  src_router: string;
  dst_router: string;
  hops: string[];
  total_latency_ms: number;
}

export interface YensRow {
  route: number;
  hops: string[];
  total_latency_ms: number;
}

export interface IntentRow {
  id: string;
  name: string;
  protocol: string;
  port: number | null;
  expected_result: string;
  policy_type: string;
  src_city: string;
  dst_city: string;
  validation_status: string;
  observed_result: string;
  hop_count: number;
  latency_ms: number | null;
  consumer: string | null;
  consumer_label: string | null;
  violation_type: string | null;
  violation_detail: string | null;
}

export interface IntentPathRow {
  hop: number;
  hostname: string;
  role: string;
  city: string;
  region: string;
}

export interface ServiceImpactRow {
  intent_id: string;
  intent_name: string;
  consumer_label: string;
  src_city: string;
  dst_city: string;
  baseline_status: string;
  reachable_now: boolean;
  latency_ms: number | null;
}

// ── Topology ─────────────────────────────────────────────────────

export async function getOverview(): Promise<OverviewRow[]> {
  return runQuery<OverviewRow>(
    `MATCH (r:Router)-[:LOCATED_IN]->(c:City)
     RETURN c.region AS region, r.role AS role, count(r) AS routers
     ORDER BY region, role`
  );
}

export async function getMediumBreakdown(): Promise<MediumRow[]> {
  return runQuery<MediumRow>(
    `MATCH (:Interface)-[l:LINK]->(:Interface)
     RETURN l.medium AS medium, count(l) AS links, sum(l.capacity_gbps) AS total_capacity_gbps
     ORDER BY medium`
  );
}

export async function getCities(): Promise<CityRow[]> {
  return runQuery<CityRow>(
    `MATCH (c:City)
     OPTIONAL MATCH (c)<-[:LOCATED_IN]-(r:Router)
     RETURN c.code AS code, c.name AS name, c.region AS region, c.lat AS lat, c.lon AS lon,
            count(r) AS routerCount
     ORDER BY c.code`
  );
}

export async function getAllRouters(): Promise<RouterRow[]> {
  return runQuery<RouterRow>(
    `MATCH (r:Router)-[:LOCATED_IN]->(c:City)
     RETURN r.hostname AS hostname, r.role AS role, r.os AS os, c.code AS city, r.status AS status
     ORDER BY r.hostname`
  );
}

export async function getCityRouters(code: string): Promise<RouterRow[]> {
  return runQuery<RouterRow>(
    `MATCH (r:Router)-[:LOCATED_IN]->(c:City {code: $code})
     RETURN r.hostname AS hostname, r.role AS role, r.os AS os, c.code AS city, r.status AS status
     ORDER BY r.hostname`,
    { code }
  );
}

export async function getRouterNeighbors(
  hostname: string
): Promise<{ hostname: string; city: string; latency_ms: number }[]> {
  return runQuery(
    `MATCH (r:Router {hostname: $hostname})-[c:CONNECTED_TO]-(n:Router)-[:LOCATED_IN]->(city:City)
     RETURN n.hostname AS hostname, city.code AS city, c.latency_ms AS latency_ms
     ORDER BY n.hostname`,
    { hostname }
  );
}

export async function getRouterBgpPeers(
  hostname: string
): Promise<{ peer: string; type: string }[]> {
  return runQuery(
    `MATCH (r:Router {hostname: $hostname})-[p:BGP_PEER]-(n:Router)
     RETURN n.hostname AS peer, p.type AS type
     UNION
     MATCH (r:Router {hostname: $hostname})-[p:EBGP_PEER]->(n:Provider)
     RETURN n.name AS peer, p.type AS type`,
    { hostname }
  );
}

export async function getTopologyGraph(): Promise<{ nodes: TopologyNode[]; links: TopologyLink[] }> {
  const nodes = await runQuery<TopologyNode>(
    `MATCH (r:Router)-[:LOCATED_IN]->(c:City)
     RETURN r.hostname AS hostname, r.role AS role, c.code AS city, c.region AS region,
            c.lat AS lat, c.lon AS lon`
  );
  const links = await runQuery<TopologyLink>(
    `MATCH (a:Router)-[c:CONNECTED_TO]->(b:Router)
     RETURN a.hostname AS a, b.hostname AS b, c.latency_ms AS latency_ms`
  );
  return { nodes, links };
}

// ── Q2/Q4 — Blast radius & double-failure what-if ──────────────

const BLAST_RADIUS_CYPHER = `CYPHER 25
MATCH (hq:Router {role:'CORE'})-[:LOCATED_IN]->(:City {code:'PAR'})
WHERE NOT hq.hostname IN $failed
WITH collect(hq) AS hqs
MATCH (r:Router)-[:LOCATED_IN]->(c:City)
WHERE NOT r.hostname IN $failed
WITH hqs, c, collect(r) AS cityRouters
WHERE NONE(r IN cityRouters WHERE EXISTS {
  MATCH (r)(()-[:CONNECTED_TO]-(mid:Router WHERE NOT mid.hostname IN $failed))*(hq)
  WHERE hq IN hqs
})
RETURN c.code AS isolated_city, c.name AS name, [r IN cityRouters | r.hostname] AS stranded_routers
ORDER BY c.code`;

export async function blastRadius(failed: string[]): Promise<BlastRadiusRow[]> {
  return runQuery<BlastRadiusRow>(BLAST_RADIUS_CYPHER, { failed });
}

export async function criticalCorePairs(): Promise<CriticalPairRow[]> {
  return runQuery<CriticalPairRow>(
    `CYPHER 25
     MATCH (c1:Router {role:'CORE'}), (c2:Router {role:'CORE'})
     WHERE c1.hostname < c2.hostname
     WITH [c1.hostname, c2.hostname] AS failed
     CALL (failed) {
       MATCH (hq:Router {role:'CORE'})-[:LOCATED_IN]->(:City {code:'PAR'})
       WHERE NOT hq.hostname IN failed
       WITH failed, collect(hq) AS hqs
       WHERE size(hqs) > 0
       MATCH (r:Router)-[:LOCATED_IN]->(c:City)
       WHERE NOT r.hostname IN failed
       WITH failed, hqs, c, collect(r) AS cityRouters
       WHERE NONE(r IN cityRouters WHERE EXISTS {
         MATCH (r)(()-[:CONNECTED_TO]-(mid:Router WHERE NOT mid.hostname IN failed))*(hq)
         WHERE hq IN hqs
       })
       RETURN collect(c.code) AS isolated_cities
     }
     WITH failed, isolated_cities
     WHERE size(isolated_cities) > 0
     RETURN failed AS failed_core_pair, isolated_cities
     ORDER BY size(isolated_cities) DESC, failed_core_pair`
  );
}

// ── Q3 — SPOF: articulation points & bridges (GDS) ─────────────

export async function articulationPoints(): Promise<SpofRow[]> {
  return withGroup("SPOF — articulation points (GDS)", async () => {
    return runQuery<SpofRow>(
      `CALL () {
         CALL gds.graph.drop('wan_ui_ap', false) YIELD graphName
         RETURN count(graphName) AS dropped
       }
       CALL gds.graph.project('wan_ui_ap', 'Router', {CONNECTED_TO: {orientation: 'UNDIRECTED'}}) YIELD graphName
       CALL gds.articulationPoints.stream(graphName) YIELD nodeId
       RETURN gds.util.asNode(nodeId).hostname AS spof_router
       ORDER BY spof_router`
    );
  });
}

export async function bridges(): Promise<BridgeRow[]> {
  return withGroup("SPOF — bridges (GDS)", async () => {
    return runQuery<BridgeRow>(
      `CALL () {
         CALL gds.graph.drop('wan_ui_br', false) YIELD graphName
         RETURN count(graphName) AS dropped
       }
       CALL gds.graph.project('wan_ui_br', 'Router', {CONNECTED_TO: {orientation: 'UNDIRECTED'}}) YIELD graphName
       CALL gds.bridges.stream(graphName) YIELD from, to
       RETURN gds.util.asNode(from).hostname AS endpoint_a, gds.util.asNode(to).hostname AS endpoint_b
       ORDER BY endpoint_a, endpoint_b`
    );
  });
}

// ── Q5 — resilience / path diversity ────────────────────────────

export async function shortestPath(src: string, dst: string): Promise<ShortestPathRow | null> {
  const rows = await runQuery<ShortestPathRow>(
    `CYPHER 25
     MATCH (a:Router)-[:LOCATED_IN]->(:City {code: $src}),
           (b:Router)-[:LOCATED_IN]->(:City {code: $dst})
     MATCH p = SHORTEST 1 (a)-[:CONNECTED_TO]-+(b)
     RETURN a.hostname AS src_router, b.hostname AS dst_router,
            [n IN nodes(p) | n.hostname] AS hops,
            reduce(total = 0.0, r IN relationships(p) | total + r.latency_ms) AS total_latency_ms
     ORDER BY total_latency_ms ASC
     LIMIT 1`,
    { src, dst }
  );
  return rows[0] ?? null;
}

export async function yensPaths(src: string, dst: string, k = 3): Promise<YensRow[]> {
  return withGroup(`Path diversity — Yen's k=${k} (GDS)`, async () => {
    return runQuery<YensRow>(
      `CALL () {
         CALL gds.graph.drop('wan_ui_yens', false) YIELD graphName
         RETURN count(graphName) AS dropped
       }
       CALL gds.graph.project('wan_ui_yens', 'Router',
         {CONNECTED_TO: {orientation: 'UNDIRECTED', properties: 'latency_ms'}}) YIELD graphName
       MATCH (src:Router)-[:LOCATED_IN]->(:City {code: $src})
       WITH graphName, src ORDER BY src.hostname LIMIT 1
       MATCH (dst:Router)-[:LOCATED_IN]->(:City {code: $dst})
       WITH graphName, src, dst ORDER BY dst.hostname LIMIT 1
       CALL gds.shortestPath.yens.stream(graphName, {
         sourceNode: src, targetNode: dst, k: $k, relationshipWeightProperty: 'latency_ms'
       }) YIELD index, totalCost, nodeIds
       RETURN index + 1 AS route, [id IN nodeIds | gds.util.asNode(id).hostname] AS hops,
              totalCost AS total_latency_ms`,
      { src, dst, k: neo4j.int(k) }
    );
  });
}

// ── Q6 — incident RCA ───────────────────────────────────────────

export async function createIncident(hostname: string): Promise<void> {
  await runQuery(
    `MERGE (i:Incident {id: 'INC-DEMO-' + $hostname})
     SET i.severity = 'P1', i.type = 'HW_FAILURE'
     WITH i
     MATCH (r:Router {hostname: $hostname})
     MERGE (i)-[:AFFECTS]->(r)
     SET r.status = 'DOWN'`,
    { hostname }
  );
}

export async function getIncidentImpact(): Promise<BlastRadiusRow[]> {
  return runQuery<BlastRadiusRow>(
    `CYPHER 25
     MATCH (:Incident)-[:AFFECTS]->(fr:Router)
     WITH collect(DISTINCT fr.hostname) AS failed
     MATCH (hq:Router {role:'CORE'})-[:LOCATED_IN]->(:City {code:'PAR'})
     WHERE NOT hq.hostname IN failed
     WITH failed, collect(hq) AS hqs
     MATCH (r:Router)-[:LOCATED_IN]->(c:City)
     WHERE NOT r.hostname IN failed
     WITH failed, hqs, c, collect(r) AS cityRouters
     WHERE NONE(r IN cityRouters WHERE EXISTS {
       MATCH (r)(()-[:CONNECTED_TO]-(mid:Router WHERE NOT mid.hostname IN failed))*(hq)
       WHERE hq IN hqs
     })
     RETURN c.code AS isolated_city, c.name AS name, [r IN cityRouters | r.hostname] AS stranded_routers
     ORDER BY c.code`
  );
}

export async function resetIncidents(): Promise<void> {
  await runQuery(
    `MATCH (i:Incident) WHERE i.id STARTS WITH 'INC-DEMO-'
     OPTIONAL MATCH (i)-[:AFFECTS]->(r:Router)
     SET r.status = 'UP'
     WITH i
     DETACH DELETE i`
  );
}

export async function hasActiveIncident(): Promise<boolean> {
  const rows = await runQuery<{ n: number }>(
    `MATCH (i:Incident) WHERE i.id STARTS WITH 'INC-DEMO-' RETURN count(i) AS n`
  );
  return (rows[0]?.n ?? 0) > 0;
}

// ── Flow layer — Intent / OperationalPath / Validation / Compliance ─

export async function getIntents(): Promise<IntentRow[]> {
  return runQuery<IntentRow>(
    `MATCH (i:Intent)
     OPTIONAL MATCH (i)-[:RESOLVED_BY]->(op:OperationalPath)
     OPTIONAL MATCH (i)-[:VALIDATED_BY]->(vr:ValidationResult)
     OPTIONAL MATCH (i)-[:VIOLATED_BY]->(sv:SecurityViolation)
     OPTIONAL MATCH (consumer)-[:USES_INTENT]->(i)
     RETURN i.id AS id, i.name AS name, i.protocol AS protocol, i.port AS port,
            i.expected_result AS expected_result, i.policy_type AS policy_type,
            i.src_city AS src_city, i.dst_city AS dst_city,
            vr.validation_status AS validation_status, vr.observed_result AS observed_result,
            op.hop_count AS hop_count, op.latency_ms AS latency_ms,
            labels(consumer)[0] AS consumer, consumer.name AS consumer_label,
            sv.violation_type AS violation_type, sv.detail AS violation_detail
     ORDER BY i.id`
  );
}

export async function getIntentPath(intentId: string): Promise<IntentPathRow[]> {
  return runQuery<IntentPathRow>(
    `MATCH (:Intent {id: $intentId})-[:RESOLVED_BY]->(:OperationalPath)-[t:TRAVERSES]->(r:Router)
     MATCH (r)-[:LOCATED_IN]->(c:City)
     RETURN t.order AS hop, r.hostname AS hostname, r.role AS role, c.code AS city, c.region AS region
     ORDER BY hop`,
    { intentId }
  );
}

const REVALIDATE_CYPHER = `CYPHER 25
MATCH (a:Router)-[:LOCATED_IN]->(:City {code: $src})
WHERE NOT a.hostname IN $failed
WITH a ORDER BY a.hostname LIMIT 1
MATCH (b:Router)-[:LOCATED_IN]->(:City {code: $dst})
WHERE NOT b.hostname IN $failed
WITH a, b ORDER BY b.hostname LIMIT 1
OPTIONAL MATCH p = SHORTEST 1 (a)(()-[:CONNECTED_TO]-(mid:Router WHERE NOT mid.hostname IN $failed))*(b)
RETURN p IS NOT NULL AS reachable,
       CASE WHEN p IS NOT NULL THEN reduce(t = 0.0, r IN relationships(p) | t + r.latency_ms) ELSE null END AS latency_ms`;

/** Service Impact Analysis: given failed routers, re-run each REACHABILITY intent's
 * path resolution live (read-only — the persisted baseline OperationalPath/ValidationResult
 * is not mutated by this what-if exploration). */
export async function serviceImpactAnalysis(failed: string[]): Promise<ServiceImpactRow[]> {
  return withGroup(`Service Impact Analysis (failed=${failed.join(",") || "none"})`, async () => {
    const intents = await runQuery<{
      id: string;
      name: string;
      src_city: string;
      dst_city: string;
      validation_status: string;
      consumer_label: string | null;
    }>(
      `MATCH (i:Intent {policy_type: 'REACHABILITY'})
       OPTIONAL MATCH (i)-[:VALIDATED_BY]->(vr:ValidationResult)
       OPTIONAL MATCH (consumer)-[:USES_INTENT]->(i)
       RETURN i.id AS id, i.name AS name, i.src_city AS src_city, i.dst_city AS dst_city,
              vr.validation_status AS validation_status, consumer.name AS consumer_label
       ORDER BY i.id`
    );
    const results: ServiceImpactRow[] = [];
    for (const intent of intents) {
      const rows = await runQuery<{ reachable: boolean; latency_ms: number | null }>(
        REVALIDATE_CYPHER,
        { src: intent.src_city, dst: intent.dst_city, failed }
      );
      const row = rows[0];
      results.push({
        intent_id: intent.id,
        intent_name: intent.name,
        consumer_label: intent.consumer_label ?? "—",
        src_city: intent.src_city,
        dst_city: intent.dst_city,
        baseline_status: intent.validation_status,
        reachable_now: row?.reachable ?? false,
        latency_ms: row?.latency_ms ?? null,
      });
    }
    return results;
  });
}
