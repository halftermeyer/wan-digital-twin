// Q3 — SPOFs: articulation points (routers) and bridges (links) via GDS on the derived layer
CALL gds.graph.project('wan', 'Router', {CONNECTED_TO: {orientation: 'UNDIRECTED'}});

CALL gds.articulationPoints.stream('wan')
YIELD nodeId
RETURN gds.util.asNode(nodeId).hostname AS spof_router
ORDER BY spof_router;

CALL gds.bridges.stream('wan')
YIELD from, to
RETURN gds.util.asNode(from).hostname AS endpoint_a, gds.util.asNode(to).hostname AS endpoint_b
ORDER BY endpoint_a, endpoint_b;

CALL gds.graph.drop('wan');
