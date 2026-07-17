// Derived router-to-router layer from physical interface links
MATCH (r1:Router)-[:HAS_INTERFACE]->(i1:Interface)-[l:LINK]-(i2:Interface)<-[:HAS_INTERFACE]-(r2:Router)
WHERE r1.hostname < r2.hostname
MERGE (r1)-[c:CONNECTED_TO]->(r2)
SET c.latency_ms = l.latency_ms, c.capacity_gbps = l.capacity_gbps;
