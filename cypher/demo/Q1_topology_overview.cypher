// Q1 — topology overview: router counts by region/role, link counts by medium, then the schema
MATCH (r:Router)-[:LOCATED_IN]->(c:City)
RETURN c.region AS region, r.role AS role, count(r) AS routers
ORDER BY region, role;

MATCH (:Interface)-[l:LINK]->(:Interface)
RETURN l.medium AS medium, count(l) AS links, sum(l.capacity_gbps) AS total_capacity_gbps
ORDER BY medium;

CALL db.schema.visualization();
