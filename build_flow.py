#!/usr/bin/env python3
"""Build the Flow layer (Intent -> OperationalPath -> Validation -> Compliance) on
top of the WAN topology, per the network digital twin target schema:
Application/Service -[USES_INTENT]-> Intent -[SOURCE/DESTINATION]-> IntentGroup,
Intent -[RESOLVED_BY]-> OperationalPath -[TRAVERSES]-> Router, Intent -[VALIDATED_BY]->
ValidationResult, Intent -[VIOLATED_BY]-> SecurityViolation.

Path resolution here is done by the graph's own shortest-path engine (CYPHER 25 QPP),
not Batfish — this synthetic topology has no real device configs for Batfish to parse.
On a real, config-backed deployment the same schema is populated by Batfish
reachability/traceroute (see ingest_batfish.py); "Batfish calcule, Neo4j memorise"
still holds, only the resolver differs. Idempotent: safe to re-run (MERGE throughout).
"""
import os
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parent

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "wan")

# Cities referenced by the intents below, as IntentGroups (group_type CITY — a real
# deployment would key IntentGroup by VRF / app-tier / user-segment instead).
CITIES = ["PAR", "FRA", "LON", "SGP", "JNB", "NYC", "SAO", "DXB"]

INTENTS = [
    {
        "id": "INT-001", "name": "SWIFT Payment Gateway reachability",
        "src": "PAR", "dst": "FRA", "protocol": "BGP", "port": None,
        "expected_result": "ALLOW", "policy_type": "REACHABILITY",
        "description": "SWIFT payment gateway traffic between the Paris and Frankfurt cores must always be permitted.",
        "service": ("SVC-SWIFT", "SWIFT Payment Gateway", "PAYMENTS"),
    },
    {
        "id": "INT-002", "name": "FX Trading Platform reachability + SLA",
        "src": "LON", "dst": "SGP", "protocol": "TCP", "port": 443,
        "expected_result": "ALLOW", "policy_type": "REACHABILITY",
        "max_latency_ms": 150,
        "description": "FX trading platform traffic between London and Singapore desks must be permitted within a 150ms latency budget.",
        "service": ("SVC-FX", "FX Trading Platform", "TRADING"),
    },
    {
        "id": "INT-003", "name": "Core Banking DR Replication reachability",
        "src": "PAR", "dst": "JNB", "protocol": "TCP", "port": None,
        "expected_result": "ALLOW", "policy_type": "REACHABILITY",
        "description": "Core banking DR replication from Paris HQ to the Johannesburg branch must be permitted. Single-homed (JNB-EDGE-01 -> PAR-CORE-01 only) — no alternate path exists.",
        "service": ("SVC-DR", "Core Banking DR Replication", "DR"),
    },
    {
        "id": "INT-004", "name": "Market Data Feed reachability",
        "src": "NYC", "dst": "SAO", "protocol": "UDP", "port": None,
        "expected_result": "ALLOW", "policy_type": "REACHABILITY",
        "description": "Market data feed from New York to Sao Paulo must be permitted. Sao Paulo is a 2-cut of the NYC core pair — no alternate path exists.",
        "service": ("SVC-MKT", "Market Data Feed", "MARKET_DATA"),
    },
    {
        "id": "INT-005", "name": "APAC data residency (DXB intra-region)",
        "src": "DXB", "dst": "SGP", "protocol": "ANY", "port": None,
        "expected_result": "DENY_TRANSIT", "policy_type": "COMPLIANCE",
        "description": "Intra-APAC traffic (Dubai to Singapore) must not transit a router located outside the APAC region.",
        "application": ("APP-COMPLIANCE", "Regulatory Data Residency Monitor", "COMPLIANCE"),
    },
]

RESOLVE_PATH = """CYPHER 25
MATCH (a:Router)-[:LOCATED_IN]->(:City {code: $src})
WITH a ORDER BY a.hostname LIMIT 1
MATCH (b:Router)-[:LOCATED_IN]->(:City {code: $dst})
WITH a, b ORDER BY b.hostname LIMIT 1
MATCH p = SHORTEST 1 (a)-[:CONNECTED_TO]-+(b)
WITH p, reduce(t = 0.0, r IN relationships(p) | t + r.latency_ms) AS latency_ms
ORDER BY latency_ms ASC LIMIT 1
UNWIND range(0, size(nodes(p)) - 1) AS idx
MATCH (n) WHERE n = nodes(p)[idx]
OPTIONAL MATCH (n)-[:LOCATED_IN]->(c:City)
RETURN idx AS hop, n.hostname AS hostname, c.region AS region, latency_ms
ORDER BY idx"""

# Given $failed routers, is (src city -> dst city) still reachable? No writes.
REVALIDATE_PATH = """CYPHER 25
MATCH (a:Router)-[:LOCATED_IN]->(:City {code: $src})
WHERE NOT a.hostname IN $failed
WITH a ORDER BY a.hostname LIMIT 1
MATCH (b:Router)-[:LOCATED_IN]->(:City {code: $dst})
WHERE NOT b.hostname IN $failed
WITH a, b ORDER BY b.hostname LIMIT 1
OPTIONAL MATCH p = SHORTEST 1 (a)(()-[:CONNECTED_TO]-(mid:Router WHERE NOT mid.hostname IN $failed))*(b)
RETURN a.hostname AS src_router, b.hostname AS dst_router,
       p IS NOT NULL AS reachable,
       CASE WHEN p IS NOT NULL THEN reduce(t = 0.0, r IN relationships(p) | t + r.latency_ms) ELSE null END AS latency_ms,
       CASE WHEN p IS NOT NULL THEN [n IN nodes(p) | n.hostname] ELSE null END AS hops"""


def statements(path):
    for chunk in path.read_text().split(";"):
        lines = [l for l in chunk.splitlines() if l.strip() and not l.strip().startswith("//")]
        if lines:
            yield chunk.strip()


def build_intent_groups(session):
    session.run("""
        UNWIND $cities AS code
        MATCH (c:City {code: code})
        MERGE (g:IntentGroup {id: 'IG-' + code})
        SET g.name = c.name, g.group_type = 'CITY'
        WITH g, c
        MATCH (r:Router)-[:LOCATED_IN]->(c)
        MERGE (g)-[:MEMBER]->(r)
    """, cities=CITIES).consume()


def resolve_and_persist(session, intent):
    hops = session.run(RESOLVE_PATH, src=intent["src"], dst=intent["dst"]).data()
    regions = {h["region"] for h in hops}
    allowed_regions = {intent["src_region"], intent["dst_region"]}
    latency_ms = hops[-1]["latency_ms"] if hops else None
    hop_count = len(hops)

    violates_transit = (
        intent["expected_result"] == "DENY_TRANSIT" and not regions.issubset(allowed_regions)
    )
    sla_breached = intent.get("max_latency_ms") is not None and latency_ms is not None \
        and latency_ms > intent["max_latency_ms"]

    if intent["policy_type"] == "COMPLIANCE":
        validation_status = "FAIL" if violates_transit else "PASS"
        observed_result = "PERMITTED" if hop_count > 0 else "UNREACHABLE"
    else:
        validation_status = "FAIL" if (hop_count == 0 or sla_breached) else "PASS"
        observed_result = "PERMITTED" if hop_count > 0 else "UNREACHABLE"

    session.run("""
        MATCH (intent:Intent {id: $iid})
        MERGE (op:OperationalPath {id: 'OP-' + $iid})
        SET op.path_type = 'CONTROL_PLANE', op.protocol = $protocol,
            op.hop_count = $hop_count, op.latency_ms = $latency_ms,
            op.health = CASE WHEN $hop_count > 0 THEN 'HEALTHY' ELSE 'DOWN' END
        MERGE (intent)-[:RESOLVED_BY]->(op)
        WITH op
        OPTIONAL MATCH (op)-[t:TRAVERSES]->() DELETE t
        WITH op
        UNWIND $hops AS h
        MATCH (r:Router {hostname: h.hostname})
        MERGE (op)-[t:TRAVERSES]->(r)
        SET t.order = h.hop
    """, iid=intent["id"], protocol=intent["protocol"], hop_count=hop_count,
         latency_ms=latency_ms, hops=hops).consume()

    session.run("""
        MATCH (intent:Intent {id: $iid})
        MERGE (vr:ValidationResult {id: 'VR-' + $iid})
        SET vr.validation_status = $status, vr.observed_result = $observed,
            vr.engine = 'GraphPathResolver'
        MERGE (intent)-[:VALIDATED_BY]->(vr)
    """, iid=intent["id"], status=validation_status, observed=observed_result).consume()

    if violates_transit:
        foreign = sorted(regions - allowed_regions)
        session.run("""
            MATCH (intent:Intent {id: $iid})
            MERGE (sv:SecurityViolation {id: 'SV-' + $iid})
            SET sv.severity = 'HIGH', sv.violation_type = 'DATA_RESIDENCY_TRANSIT',
                sv.detail = 'Path transits region(s) ' + $foreign + ' outside allowed ' + $allowed
            MERGE (intent)-[:VIOLATED_BY]->(sv)
        """, iid=intent["id"], foreign=str(foreign), allowed=str(sorted(allowed_regions))).consume()

    return validation_status, observed_result, hop_count, latency_ms, sorted(regions)


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session(database=NEO4J_DATABASE) as s:
        for stmt in statements(ROOT / "cypher" / "03_flow_constraints.cypher"):
            s.run(stmt).consume()
        print("Flow constraints created")

        build_intent_groups(s)
        print(f"IntentGroups built for {len(CITIES)} cities")

        city_region = {r["code"]: r["region"] for r in s.run(
            "MATCH (c:City) RETURN c.code AS code, c.region AS region")}

        for intent in INTENTS:
            intent["src_region"] = city_region[intent["src"]]
            intent["dst_region"] = city_region[intent["dst"]]

            s.run("""
                MERGE (i:Intent {id: $id})
                SET i.name = $name, i.protocol = $protocol, i.port = $port,
                    i.expected_result = $expected_result, i.policy_type = $policy_type,
                    i.description = $description, i.src_city = $src, i.dst_city = $dst
                WITH i
                MATCH (sg:IntentGroup {id: 'IG-' + $src})
                MERGE (i)-[:SOURCE]->(sg)
                WITH i
                MATCH (dg:IntentGroup {id: 'IG-' + $dst})
                MERGE (i)-[:DESTINATION]->(dg)
            """, id=intent["id"], name=intent["name"], protocol=intent["protocol"],
                 port=intent["port"], expected_result=intent["expected_result"],
                 policy_type=intent["policy_type"], description=intent["description"],
                 src=intent["src"], dst=intent["dst"]).consume()

            if "service" in intent:
                sid, sname, stype = intent["service"]
                s.run("""
                    MERGE (svc:Service {id: $sid})
                    SET svc.name = $name, svc.service_type = $stype
                    WITH svc
                    MATCH (i:Intent {id: $iid})
                    MERGE (svc)-[:USES_INTENT]->(i)
                """, sid=sid, name=sname, stype=stype, iid=intent["id"]).consume()
            if "application" in intent:
                aid, aname, atype = intent["application"]
                s.run("""
                    MERGE (app:Application {id: $aid})
                    SET app.name = $name, app.criticality = $atype
                    WITH app
                    MATCH (i:Intent {id: $iid})
                    MERGE (app)-[:USES_INTENT]->(i)
                """, aid=aid, name=aname, atype=atype, iid=intent["id"]).consume()

            status, observed, hops, latency, regions = resolve_and_persist(s, intent)
            print(f"{intent['id']} {intent['src']}->{intent['dst']}: "
                  f"{status} ({observed}), {hops} hops, {latency}ms, regions={regions}")

        n = s.run("""
            MATCH (n) WHERE n:Intent OR n:IntentGroup OR n:OperationalPath
                          OR n:ValidationResult OR n:SecurityViolation OR n:Service OR n:Application
            RETURN labels(n)[0] AS label, count(n) AS n ORDER BY label
        """).data()
        print("Flow layer node counts:", {r["label"]: r["n"] for r in n})
    driver.close()


if __name__ == "__main__":
    main()
