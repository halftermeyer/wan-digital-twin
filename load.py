#!/usr/bin/env python3
"""Load the generated CSVs into Neo4j and build the derived CONNECTED_TO layer.

Wipes the target database first so every run starts from a clean, reproducible
state. Order: constraints -> cities -> routers -> LOCATED_IN -> interfaces ->
HAS_INTERFACE -> LINK -> iBGP -> providers/eBGP -> derived layer.
"""
import csv
import os
import sys
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CYPHER = ROOT / "cypher"
BATCH = 500

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")


def read_csv(name):
    with open(DATA / name, newline="") as f:
        return list(csv.DictReader(f))


def statements(path):
    """Split a .cypher file on ';' and drop comment-only fragments."""
    for chunk in path.read_text().split(";"):
        lines = [l for l in chunk.splitlines() if l.strip() and not l.strip().startswith("//")]
        if lines:
            yield chunk.strip()


def run_batched(session, query, rows):
    for start in range(0, len(rows), BATCH):
        session.run(query, rows=rows[start:start + BATCH]).consume()


def main():
    if not (DATA / "cities.csv").exists():
        sys.exit("data/ CSVs not found — run generate_topology.py first")

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session(database=NEO4J_DATABASE) as s:
        print(f"Connected to {NEO4J_URI} (database: {NEO4J_DATABASE})")

        s.run("MATCH (n) DETACH DELETE n").consume()
        print("Database wiped")

        for stmt in statements(CYPHER / "01_constraints.cypher"):
            s.run(stmt).consume()
        print("Constraints created")

        run_batched(s, """
            UNWIND $rows AS row
            MERGE (c:City {code: row.code})
            SET c.name = row.name, c.country = row.country, c.region = row.region,
                c.lat = toFloat(row.lat), c.lon = toFloat(row.lon)
        """, read_csv("cities.csv"))

        routers = read_csv("routers.csv")
        run_batched(s, """
            UNWIND $rows AS row
            MERGE (r:Router {hostname: row.hostname})
            SET r.role = row.role, r.os = row.os, r.asn = toInteger(row.asn),
                r.loopback_ip = row.loopback_ip, r.status = row.status
        """, routers)
        run_batched(s, """
            UNWIND $rows AS row
            MATCH (r:Router {hostname: row.hostname}), (c:City {code: row.city_code})
            MERGE (r)-[:LOCATED_IN]->(c)
        """, routers)

        interfaces = read_csv("interfaces.csv")
        run_batched(s, """
            UNWIND $rows AS row
            MERGE (i:Interface {id: row.id})
            SET i.name = row.name, i.capacity_gbps = toFloat(row.capacity_gbps),
                i.status = row.status
        """, interfaces)
        run_batched(s, """
            UNWIND $rows AS row
            MATCH (r:Router {hostname: row.hostname}), (i:Interface {id: row.id})
            MERGE (r)-[:HAS_INTERFACE]->(i)
        """, interfaces)

        run_batched(s, """
            UNWIND $rows AS row
            MATCH (ia:Interface {id: row.interface_a}), (ib:Interface {id: row.interface_b})
            WITH row,
                 CASE WHEN elementId(ia) < elementId(ib) THEN ia ELSE ib END AS a,
                 CASE WHEN elementId(ia) < elementId(ib) THEN ib ELSE ia END AS b
            MERGE (a)-[l:LINK]->(b)
            SET l.medium = row.medium, l.latency_ms = toFloat(row.latency_ms),
                l.capacity_gbps = toFloat(row.capacity_gbps)
        """, read_csv("links.csv"))

        bgp = read_csv("bgp_sessions.csv")
        run_batched(s, """
            UNWIND $rows AS row
            MATCH (a:Router {hostname: row.router}), (b:Router {hostname: row.peer})
            MERGE (a)-[p:BGP_PEER]->(b)
            SET p.type = 'iBGP'
        """, [r for r in bgp if r["type"] == "iBGP"])

        run_batched(s, """
            UNWIND $rows AS row
            MERGE (p:Provider {name: row.name})
            SET p.asn = toInteger(row.asn)
        """, read_csv("providers.csv"))
        run_batched(s, """
            UNWIND $rows AS row
            MATCH (r:Router {hostname: row.router}), (p:Provider {name: row.peer})
            MERGE (r)-[e:EBGP_PEER]->(p)
            SET e.type = 'eBGP'
        """, [r for r in bgp if r["type"] == "eBGP"])
        print("CSVs loaded")

        for stmt in statements(CYPHER / "02_derived_layer.cypher"):
            s.run(stmt).consume()
        print("Derived CONNECTED_TO layer built")

        counts = s.run("""
            MATCH (n)
            RETURN [lbl IN labels(n) | lbl][0] AS label, count(n) AS n
            ORDER BY label
        """).data()
        rels = s.run("""
            MATCH ()-[r]->()
            RETURN type(r) AS type, count(r) AS n ORDER BY type
        """).data()
        print("Nodes:", {c["label"]: c["n"] for c in counts})
        print("Rels: ", {r["type"]: r["n"] for r in rels})
    driver.close()


if __name__ == "__main__":
    main()
