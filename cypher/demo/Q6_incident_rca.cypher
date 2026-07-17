// Q6 — incident RCA overlay: P1 incident on PAR-CORE-01, impact analysis, incident subgraph
// Step 1 — create the incident and mark the affected router
MERGE (i:Incident {id: 'INC-2026-0001'})
SET i.severity = 'P1', i.type = 'HW_FAILURE', i.started_at = datetime('2026-07-05T08:12:00Z')
WITH i
MATCH (r:Router {hostname: 'PAR-CORE-01'})
MERGE (i)-[:AFFECTS]->(r)
SET r.status = 'DOWN'
RETURN i.id AS incident, r.hostname AS affected_router, r.status AS simulated_status;

// Step 2 — impacted cities: Q2 logic driven by the incident's affected routers
CYPHER 25
MATCH (:Incident {id: 'INC-2026-0001'})-[:AFFECTS]->(fr:Router)
WITH collect(fr.hostname) AS failed
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
RETURN c.code AS impacted_city, c.name, [r IN cityRouters | r.hostname] AS stranded_routers
ORDER BY c.code;

// Step 3 — incident subgraph for Bloom/Browser visualization
MATCH p = (i:Incident {id: 'INC-2026-0001'})-[:AFFECTS]->(r:Router)-[:CONNECTED_TO]-(:Router)
RETURN p;

// Reset (run after the demo step to restore the baseline):
// MATCH (i:Incident {id: 'INC-2026-0001'}) DETACH DELETE i;
// MATCH (r:Router {hostname: 'PAR-CORE-01'}) SET r.status = 'UP';
