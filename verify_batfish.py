#!/usr/bin/env python3
"""Phase 2 assertions V8-V11 on Neo4j database `batfish`. Exits 1 on failure."""
import os
import sys
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parent
DB = "batfish"

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")

ALLOWED_LABELS = {"City", "Router", "Interface", "Provider", "Incident"}
FAILURES = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(name)


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session(database=DB) as s:
        # V8 — router count and os
        n_routers = s.run("MATCH (r:Router) RETURN count(r) AS n").single()["n"]
        no_os = s.run("""
            MATCH (r:Router) WHERE r.os IS NULL OR r.os = ''
            RETURN count(r) AS n""").single()["n"]
        check("V8 Router count > 5", n_routers > 5, f"got {n_routers}")
        check("V8 every Router has os", no_os == 0, f"{no_os} without os")

        # V9 — links exist and pair-level dedup held (one LINK per interface)
        n_links = s.run("MATCH ()-[l:LINK]->() RETURN count(l) AS n").single()["n"]
        multi = s.run("""
            MATCH (i:Interface)
            WITH i, COUNT { (i)-[:LINK]-() } AS d
            WHERE d > 1
            RETURN count(i) AS n""").single()["n"]
        check("V9 LINK count > 0", n_links > 0, f"got {n_links}")
        check("V9 no interface in more than one LINK", multi == 0,
              f"{multi} interfaces with multiple links")

        # V10 — no invented labels
        labels = {r["label"] for r in s.run(
            "CALL db.labels() YIELD label RETURN label")}
        check("V10 labels subset of demo schema", labels <= ALLOWED_LABELS,
              f"extra: {labels - ALLOWED_LABELS}" if labels - ALLOWED_LABELS else str(labels))

        # V11 — Q3 (articulation points / bridges) runs unchanged on this db
        try:
            s.run("CALL gds.graph.drop('wan', false)").consume()
            s.run("""CALL gds.graph.project('wan', 'Router',
                     {CONNECTED_TO: {orientation: 'UNDIRECTED'}})""").consume()
            aps = [r["h"] for r in s.run("""
                CALL gds.articulationPoints.stream('wan') YIELD nodeId
                RETURN gds.util.asNode(nodeId).hostname AS h""")]
            bridges = s.run("CALL gds.bridges.stream('wan') YIELD from, to RETURN count(*) AS n").single()["n"]
            s.run("CALL gds.graph.drop('wan')").consume()
            check("V11 Q3 runs on batfish db", True,
                  f"articulation points={aps}, bridges={bridges}")
        except Exception as e:
            check("V11 Q3 runs on batfish db", False, str(e))
    driver.close()

    if FAILURES:
        print(f"\n{len(FAILURES)} verification(s) FAILED: {FAILURES}")
        sys.exit(1)
    print("\nAll Batfish verifications passed.")


if __name__ == "__main__":
    main()
