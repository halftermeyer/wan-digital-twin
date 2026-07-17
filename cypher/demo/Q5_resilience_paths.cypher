// Q5 — resilience / path diversity between two cities (in Browser set :param src => 'LON' and :param dst => 'SGP')
// (a) lowest-latency shortest path (by hops) over the derived layer
CYPHER 25
MATCH (a:Router)-[:LOCATED_IN]->(:City {code: $src}),
      (b:Router)-[:LOCATED_IN]->(:City {code: $dst})
MATCH p = SHORTEST 1 (a)-[:CONNECTED_TO]-+(b)
RETURN a.hostname AS src_router, b.hostname AS dst_router,
       [n IN nodes(p) | n.hostname] AS hops,
       reduce(total = 0.0, r IN relationships(p) | total + r.latency_ms) AS total_latency_ms
ORDER BY total_latency_ms ASC
LIMIT 1;

// (b) 3 alternative routes with latencies — GDS Yen's k-shortest paths (k=3)
CALL gds.graph.project('wan_weighted', 'Router',
  {CONNECTED_TO: {orientation: 'UNDIRECTED', properties: 'latency_ms'}});

MATCH (src:Router {hostname: 'LON-CORE-01'}), (dst:Router {hostname: 'SGP-CORE-01'})
CALL gds.shortestPath.yens.stream('wan_weighted', {
  sourceNode: src, targetNode: dst, k: 3, relationshipWeightProperty: 'latency_ms'
})
YIELD index, totalCost, nodeIds
RETURN index AS route, [id IN nodeIds | gds.util.asNode(id).hostname] AS hops,
       totalCost AS total_latency_ms;

CALL gds.graph.drop('wan_weighted');
