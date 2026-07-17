// Q4 — double failure what-if: run Q2 with :param failed => ['NYC-CORE-01','NYC-CORE-02'] (expected: SAO isolated)
CYPHER 25
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
RETURN c.code AS isolated_city, c.name, [r IN cityRouters | r.hostname] AS stranded_routers
ORDER BY c.code;

// Variant — enumerate ALL pairs of CORE routers whose joint failure isolates at least one city.
// Pairs taking down both PAR HQ cores are excluded (no HQ left to measure reachability against).
CYPHER 25
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
ORDER BY size(isolated_cities) DESC, failed_core_pair;
