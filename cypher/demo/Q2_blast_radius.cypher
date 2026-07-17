// Q2 — blast radius: which cities lose connectivity to Paris HQ if $failed routers go down?
// In Browser: :param failed => ['PAR-CORE-01']
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
