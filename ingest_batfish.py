#!/usr/bin/env python3
"""Phase 2 — parse the vendored Cisco configs with Batfish and load the result
into Neo4j database `batfish`, using the exact same schema as the synthetic demo.

Requires: `docker compose up -d batfish` and `pip install -r requirements-batfish.txt`.
Never touches the default database.
"""
import os
import sys
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase
from pybatfish.client.session import Session

ROOT = Path(__file__).resolve().parent
SNAPSHOT = ROOT / "batfish_snapshot"
DB = "batfish"

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")


def endpoint(value):
    """Return (hostname, interface) from a layer3Edges endpoint cell."""
    if hasattr(value, "hostname"):
        return str(value.hostname), str(value.interface)
    host, _, iface = str(value).partition("[")  # "hostname[interface]"
    return host, iface.rstrip("]")


def node_name(value):
    return str(getattr(value, "name", value))


def to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def ask_batfish():
    try:
        bf = Session(host="localhost")
    except Exception as e:
        sys.exit(
            "Cannot reach the Batfish service on localhost:9996.\n"
            "Start it first: docker compose up -d batfish  (wait ~60s), then retry.\n"
            f"Underlying error: {type(e).__name__}: {e}"
        )
    bf.set_network("ndt-demo")
    bf.init_snapshot(str(SNAPSHOT), name="ndt-demo", overwrite=True)

    nodes = bf.q.nodeProperties().answer().frame()
    edges = bf.q.layer3Edges().answer().frame()
    try:
        bgp = bf.q.bgpSessionCompatibility().answer().frame()
    except Exception:
        bgp = bf.q.bgpSessionStatus().answer().frame()
    print(f"Batfish: {len(nodes)} nodes, {len(edges)} layer-3 edges, {len(bgp)} BGP rows")
    return nodes, edges, bgp


def build_rows(nodes, edges, bgp):
    # ASN per node from the BGP frame (0 if the node runs no BGP)
    asn_by_node = {}
    for _, row in bgp.iterrows():
        asn_by_node.setdefault(node_name(row["Node"]), to_int(row.get("Local_AS")))

    routers = []
    for _, row in nodes.iterrows():
        hostname = node_name(row["Node"])
        routers.append({
            "hostname": hostname,
            "role": "CORE" if "core" in hostname.lower() else "EDGE",
            "os": str(row.get("Configuration_Format", "")),
            "asn": asn_by_node.get(hostname, 0),
            "loopback_ip": "",
            "status": "UP",
        })

    interfaces, links, seen_pairs = {}, [], set()
    for _, row in edges.iterrows():
        (h1, i1), (h2, i2) = endpoint(row["Interface"]), endpoint(row["Remote_Interface"])
        id1, id2 = f"{h1}:{i1}", f"{h2}:{i2}"
        interfaces[id1] = {"id": id1, "hostname": h1, "name": i1,
                           "capacity_gbps": 1, "status": "UP"}
        interfaces[id2] = {"id": id2, "hostname": h2, "name": i2,
                           "capacity_gbps": 1, "status": "UP"}
        pair = tuple(sorted((id1, id2)))  # each edge appears in both directions
        if pair not in seen_pairs:
            seen_pairs.add(pair)
            links.append({"interface_a": pair[0], "interface_b": pair[1],
                          "medium": "fiber", "latency_ms": 1, "capacity_gbps": 1})

    bgp_pairs, seen_bgp = [], set()
    for _, row in bgp.iterrows():
        a, b = node_name(row["Node"]), node_name(row.get("Remote_Node"))
        if not b or b == "None":
            continue
        pair = tuple(sorted((a, b)))
        if pair in seen_bgp:
            continue
        seen_bgp.add(pair)
        kind = "eBGP" if to_int(row.get("Local_AS")) != to_int(row.get("Remote_AS")) else "iBGP"
        bgp_pairs.append({"router_a": pair[0], "router_b": pair[1], "type": kind})

    return routers, list(interfaces.values()), links, bgp_pairs


def statements(path):
    for chunk in path.read_text().split(";"):
        lines = [l for l in chunk.splitlines() if l.strip() and not l.strip().startswith("//")]
        if lines:
            yield chunk.strip()


def load_neo4j(routers, interfaces, links, bgp_pairs):
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session(database="system") as s:
        s.run(f"CREATE DATABASE {DB} IF NOT EXISTS WAIT").consume()
    with driver.session(database=DB) as s:
        s.run("MATCH (n) DETACH DELETE n").consume()
        for stmt in statements(ROOT / "cypher" / "01_constraints.cypher"):
            s.run(stmt).consume()

        s.run("""
            MERGE (c:City {code: 'LAB'})
            SET c.name = 'Batfish Lab', c.country = 'N/A', c.region = 'LAB',
                c.lat = 0.0, c.lon = 0.0
        """).consume()
        s.run("""
            UNWIND $rows AS row
            MERGE (r:Router {hostname: row.hostname})
            SET r.role = row.role, r.os = row.os, r.asn = row.asn,
                r.loopback_ip = row.loopback_ip, r.status = row.status
            WITH r
            MATCH (c:City {code: 'LAB'})
            MERGE (r)-[:LOCATED_IN]->(c)
        """, rows=routers).consume()
        s.run("""
            UNWIND $rows AS row
            MERGE (i:Interface {id: row.id})
            SET i.name = row.name, i.capacity_gbps = toFloat(row.capacity_gbps),
                i.status = row.status
            WITH i, row
            MATCH (r:Router {hostname: row.hostname})
            MERGE (r)-[:HAS_INTERFACE]->(i)
        """, rows=interfaces).consume()
        s.run("""
            UNWIND $rows AS row
            MATCH (ia:Interface {id: row.interface_a}), (ib:Interface {id: row.interface_b})
            WITH row,
                 CASE WHEN elementId(ia) < elementId(ib) THEN ia ELSE ib END AS a,
                 CASE WHEN elementId(ia) < elementId(ib) THEN ib ELSE ia END AS b
            MERGE (a)-[l:LINK]->(b)
            SET l.medium = row.medium, l.latency_ms = toFloat(row.latency_ms),
                l.capacity_gbps = toFloat(row.capacity_gbps)
        """, rows=links).consume()
        s.run("""
            UNWIND $rows AS row
            MATCH (a:Router {hostname: row.router_a}), (b:Router {hostname: row.router_b})
            MERGE (a)-[p:BGP_PEER]->(b)
            SET p.type = row.type
        """, rows=bgp_pairs).consume()

        for stmt in statements(ROOT / "cypher" / "02_derived_layer.cypher"):
            s.run(stmt).consume()

        counts = {r["label"]: r["n"] for r in s.run(
            "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n")}
        print(f"Loaded into database '{DB}':", counts)
    driver.close()


def main():
    if not (SNAPSHOT / "configs").is_dir():
        sys.exit("batfish_snapshot/configs/ not found")
    nodes, edges, bgp = ask_batfish()
    load_neo4j(*build_rows(nodes, edges, bgp))
    print("Done — in Browser: `:use batfish`, then re-run Q1 and Q3 unchanged.")


if __name__ == "__main__":
    main()
