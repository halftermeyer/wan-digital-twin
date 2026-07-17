import { runQuery, withGroup } from "./neo4j";

const BENCH_DB = "benchmark";

export interface BenchmarkStep {
  label: string;
  ms: number;
  rows: number;
  detail?: string;
}

function randomSample<T>(arr: T[], n: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

async function timed(
  label: string,
  fn: () => Promise<{ rowCount: number; detail?: string }>
): Promise<BenchmarkStep> {
  const t0 = performance.now();
  try {
    const { rowCount, detail } = await fn();
    return { label, ms: Math.round(performance.now() - t0), rows: rowCount, detail };
  } catch (e) {
    return {
      label,
      ms: Math.round(performance.now() - t0),
      rows: -1,
      detail: `FAILED: ${(e as Error).message.slice(0, 300)}`,
    };
  }
}

/** Create the isolated benchmark database if missing. Never touches "wan". */
async function ensureBenchmarkDatabase(): Promise<BenchmarkStep> {
  return timed("Provision 'benchmark' database", async () => {
    const rows = await runQuery("CREATE DATABASE $db IF NOT EXISTS WAIT", { db: BENCH_DB }, "system");
    return { rowCount: rows.length };
  });
}

async function generateTopology(nRouters: number, nCore: number, meshDegree = 4, edgeHoming = 2) {
  const wipe = await timed("Reset benchmark database", async () => {
    const rows = await runQuery("MATCH (n) DETACH DELETE n", {}, BENCH_DB);
    return { rowCount: rows.length };
  });

  const constraint = await timed("Create Router.hostname constraint", async () => {
    await runQuery(
      "CREATE CONSTRAINT bench_router IF NOT EXISTS FOR (r:Router) REQUIRE r.hostname IS UNIQUE",
      {},
      BENCH_DB
    );
    return { rowCount: 0 };
  });

  const routers = Array.from({ length: nRouters }, (_, i) => ({
    hostname: `R${i}`,
    role: i < nCore ? "CORE" : "EDGE",
  }));
  const coreHosts = routers.filter((r) => r.role === "CORE").map((r) => r.hostname);

  const createRouters = await timed(`Create ${nRouters} routers (${nCore} CORE)`, async () => {
    const rows = await runQuery(
      "UNWIND $rows AS r CREATE (:Router {hostname: r.hostname, role: r.role})",
      { rows: routers },
      BENCH_DB
    );
    return { rowCount: nRouters, detail: `${rows.length}` };
  });

  const linkSet = new Set<string>();
  const links: { a: string; b: string }[] = [];
  for (const h of coreHosts) {
    for (const peer of randomSample(coreHosts.filter((x) => x !== h), Math.min(meshDegree, coreHosts.length - 1))) {
      const key = [h, peer].sort().join("|");
      if (!linkSet.has(key)) {
        linkSet.add(key);
        links.push({ a: h, b: peer });
      }
    }
  }
  for (const r of routers) {
    if (r.role === "EDGE" && coreHosts.length >= edgeHoming) {
      for (const peer of randomSample(coreHosts, edgeHoming)) {
        links.push({ a: r.hostname, b: peer });
      }
    }
  }

  const createLinks = await timed(`Create ${links.length} CONNECTED_TO links`, async () => {
    const rows = await runQuery(
      `UNWIND $rows AS r
       MATCH (a:Router {hostname: r.a}), (b:Router {hostname: r.b})
       MERGE (a)-[c:CONNECTED_TO]->(b) SET c.latency_ms = 10`,
      { rows: links },
      BENCH_DB
    );
    return { rowCount: links.length, detail: `${rows.length}` };
  });

  return { steps: [wipe, constraint, createRouters, createLinks], coreHosts, edgeHosts: routers.filter((r) => r.role === "EDGE").map((r) => r.hostname) };
}

// Reachability via a single BFS (apoc.path.subgraphNodes) from one surviving HQ,
// blacklisting the failed routers — NOT the naive per-router `EXISTS { variable-length
// MATCH }` pattern this demo's spec-prescribed Q2/Q4 use. That pattern matches
// on *trails* (walks), not simple paths: proving a router is UNREACHABLE in a graph
// with independent cycles (e.g. a meshed CORE backbone, not a sparse hub-and-spoke
// one) can force it to enumerate combinatorially many trails before concluding
// failure — fine on this demo's sparse 44-router backbone, but a real cliff on a
// denser mesh. One BFS is O(V+E) and immune to this regardless of cyclicity.
//
// Isolated-count via streaming COUNTs, never a materialized hostname list: an
// earlier version collected `reachableSet`/`allEdge` lists and diffed them with
// list `IN` — O(reachable × total) per call. At 5000 routers / 200 CORE, calling
// that shape 19,900 times (once per CORE pair, see below) blew the transaction
// memory guard (`dbms.memory.transaction.total.max`) and crashed the query rather
// than just running slowly. Counting reachable-vs-total EDGE routers is O(1)
// beyond the BFS itself, independent of graph size.
const REACHABLE_QUERY = `
MATCH (f:Router) WHERE f.hostname IN $failed
WITH collect(f) AS failedNodes
MATCH (hq:Router {role:'CORE'}) WHERE NOT hq.hostname IN $failed
WITH hq, failedNodes LIMIT 1
CALL apoc.path.subgraphNodes(hq, {relationshipFilter: 'CONNECTED_TO', blacklistNodes: failedNodes})
YIELD node
WITH count(CASE WHEN node.role <> 'CORE' THEN 1 END) AS reachableEdge
MATCH (r:Router) WHERE NOT r.role = 'CORE' AND NOT r.hostname IN $failed
WITH reachableEdge, count(r) AS totalEdge
RETURN totalEdge - reachableEdge AS isolated`;

export const BENCH_QUERY_TIMEOUT_S = 20;

/** Full benchmark suite: same query shapes as the WAN demo (Q2 / Q4b / GDS), run
 * against a synthetic graph of the requested size, in the isolated 'benchmark' db. */
export async function runBenchmarkSuite(
  nRouters: number,
  nCore: number,
  onStep?: (step: BenchmarkStep) => void
): Promise<{ steps: BenchmarkStep[]; nPairs: number }> {
  return withGroup(`Benchmark (${nRouters} routers, ${nCore} CORE)`, async () => {
    const steps: BenchmarkStep[] = [];
    const push = (s: BenchmarkStep) => {
      steps.push(s);
      onStep?.(s);
    };

    push(await ensureBenchmarkDatabase());
    const { steps: genSteps, coreHosts, edgeHosts } = await generateTopology(nRouters, nCore);
    genSteps.forEach(push);

    push(
      await timed("Blast radius (1 failed CORE) — BFS", async () => {
        const rows = await runQuery<{ isolated: number }>(
          REACHABLE_QUERY,
          { failed: [coreHosts[0]] },
          BENCH_DB,
          BENCH_QUERY_TIMEOUT_S
        );
        return { rowCount: rows[0]?.isolated ?? 0 };
      })
    );
    push(
      await timed("Blast radius (5 failed CORE) — BFS", async () => {
        const rows = await runQuery<{ isolated: number }>(
          REACHABLE_QUERY,
          { failed: coreHosts.slice(0, Math.min(5, coreHosts.length)) },
          BENCH_DB,
          BENCH_QUERY_TIMEOUT_S
        );
        return { rowCount: rows[0]?.isolated ?? 0 };
      })
    );

    const nPairs = (coreHosts.length * (coreHosts.length - 1)) / 2;
    push(
      await timed(`Critical-pair enumeration (C(${coreHosts.length},2) = ${nPairs} pairs) — BFS per pair`, async () => {
        const rows = await runQuery(
          `MATCH (c1:Router {role:'CORE'}), (c2:Router {role:'CORE'})
           WHERE c1.hostname < c2.hostname
           WITH c1, c2, [c1.hostname, c2.hostname] AS failed
           CALL (c1, c2, failed) {
             MATCH (hq:Router {role:'CORE'}) WHERE NOT hq.hostname IN failed
             WITH hq LIMIT 1
             CALL apoc.path.subgraphNodes(hq, {relationshipFilter: 'CONNECTED_TO', blacklistNodes: [c1, c2]})
             YIELD node
             WITH count(CASE WHEN node.role <> 'CORE' THEN 1 END) AS reachableEdge
             MATCH (r:Router) WHERE NOT r.role = 'CORE' AND NOT r.hostname IN failed
             WITH reachableEdge, count(r) AS totalEdge
             RETURN totalEdge - reachableEdge AS n
           }
           RETURN sum(n) AS total`,
          {},
          BENCH_DB,
          BENCH_QUERY_TIMEOUT_S
        );
        return { rowCount: nPairs, detail: `${rows[0]?.total ?? 0} stranded-router hits` };
      })
    );

    push(
      await timed("GDS project + articulationPoints", async () => {
        await runQuery("CALL gds.graph.drop('bench_g', false)", {}, BENCH_DB);
        await runQuery(
          "CALL gds.graph.project('bench_g', 'Router', {CONNECTED_TO: {orientation: 'UNDIRECTED'}})",
          {},
          BENCH_DB
        );
        const rows = await runQuery(
          "CALL gds.articulationPoints.stream('bench_g') YIELD nodeId RETURN nodeId",
          {},
          BENCH_DB
        );
        return { rowCount: rows.length };
      })
    );
    push(
      await timed("GDS bridges", async () => {
        const rows = await runQuery("CALL gds.bridges.stream('bench_g') YIELD from RETURN from", {}, BENCH_DB);
        return { rowCount: rows.length };
      })
    );
    push(
      await timed("GDS Yen's k=3 (2 random EDGE routers)", async () => {
        if (edgeHosts.length < 2) return { rowCount: 0 };
        const [src, dst] = randomSample(edgeHosts, 2);
        await runQuery(
          "CALL gds.graph.project('bench_yens', 'Router', {CONNECTED_TO: {orientation: 'UNDIRECTED', properties: 'latency_ms'}})",
          {},
          BENCH_DB
        );
        const rows = await runQuery(
          `MATCH (a:Router {hostname: $src}), (b:Router {hostname: $dst})
           CALL gds.shortestPath.yens.stream('bench_yens', {sourceNode: a, targetNode: b, k: 3, relationshipWeightProperty: 'latency_ms'})
           YIELD index RETURN index`,
          { src, dst },
          BENCH_DB
        );
        await runQuery("CALL gds.graph.drop('bench_yens', false)", {}, BENCH_DB);
        return { rowCount: rows.length };
      })
    );
    await runQuery("CALL gds.graph.drop('bench_g', false)", {}, BENCH_DB);

    return { steps, nPairs };
  });
}
