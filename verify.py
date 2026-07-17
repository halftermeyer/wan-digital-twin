#!/usr/bin/env python3
"""Hard assertions V1-V7 on the loaded graph. Exits 1 on any failure."""
import filecmp
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parent

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")

# Single source of truth: the demo query file, stripped for driver execution
Q2 = (ROOT / "cypher" / "demo" / "Q2_blast_radius.cypher").read_text().strip().rstrip(";")

FAILURES = []


def check(name, ok, detail=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        FAILURES.append(name)


def blast_radius(session, failed):
    return [r["isolated_city"] for r in session.run(Q2, failed=failed)]


def main():
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session(database=NEO4J_DATABASE) as s:
        # V1 — node counts
        counts = {r["label"]: r["n"] for r in s.run(
            "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n")}
        cores = s.run("MATCH (r:Router {role:'CORE'}) RETURN count(r) AS n").single()["n"]
        n_links = s.run("MATCH ()-[l:LINK]->() RETURN count(l) AS n").single()["n"]
        check("V1 City=20", counts.get("City") == 20, f"got {counts.get('City')}")
        check("V1 Router=44 (12 CORE)", counts.get("Router") == 44 and cores == 12,
              f"got {counts.get('Router')} routers, {cores} CORE")
        check("V1 Provider=3", counts.get("Provider") == 3, f"got {counts.get('Provider')}")
        check("V1 Interface = 2 x LINK", counts.get("Interface") == 2 * n_links,
              f"{counts.get('Interface')} interfaces, {n_links} links")

        # V2 — degrees in CONNECTED_TO
        degs = {r["h"]: r["d"] for r in s.run("""
            MATCH (r:Router {role:'EDGE'})
            RETURN r.hostname AS h, COUNT { (r)-[:CONNECTED_TO]-() } AS d
        """)}
        bad = {h: d for h, d in degs.items() if h != "JNB-EDGE-01" and d < 2}
        check("V2 all EDGE degree >= 2 (except JNB-EDGE-01)", not bad, str(bad))
        check("V2 JNB-EDGE-01 degree == 1", degs.get("JNB-EDGE-01") == 1,
              f"got {degs.get('JNB-EDGE-01')}")

        # V3 — baseline: everything reaches PAR
        base = blast_radius(s, [])
        check("V3 baseline blast radius empty", base == [], str(base))

        # V4 — PAR-CORE-01 down -> exactly JNB
        v4 = blast_radius(s, ["PAR-CORE-01"])
        check("V4 PAR-CORE-01 down -> exactly ['JNB']", v4 == ["JNB"], str(v4))

        # V5 — both NYC cores down -> SAO isolated
        v5 = blast_radius(s, ["NYC-CORE-01", "NYC-CORE-02"])
        check("V5 NYC core pair down -> SAO isolated", "SAO" in v5, str(v5))

        # V6 — articulation points include PAR-CORE-01
        s.run("CALL gds.graph.drop('wan', false)").consume()
        s.run("""CALL gds.graph.project('wan', 'Router',
                 {CONNECTED_TO: {orientation: 'UNDIRECTED'}})""").consume()
        aps = [r["h"] for r in s.run("""
            CALL gds.articulationPoints.stream('wan') YIELD nodeId
            RETURN gds.util.asNode(nodeId).hostname AS h""")]
        s.run("CALL gds.graph.drop('wan')").consume()
        check("V6 articulation points include PAR-CORE-01", "PAR-CORE-01" in aps, str(aps))

        # Q4 variant (informational): all CORE pairs whose failure isolates a city
        cores_list = sorted(r["h"] for r in s.run(
            "MATCH (r:Router {role:'CORE'}) RETURN r.hostname AS h"))
        print("Critical CORE pairs (joint failure isolates >= 1 city):")
        for i in range(len(cores_list)):
            for j in range(i + 1, len(cores_list)):
                pair = [cores_list[i], cores_list[j]]
                if pair == ["PAR-CORE-01", "PAR-CORE-02"]:
                    continue  # no HQ left to measure reachability against
                isolated = blast_radius(s, pair)
                if isolated:
                    print(f"  {pair} -> {isolated}")
    driver.close()

    # V7 — determinism: regenerate and diff
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, str(ROOT / "generate_topology.py"),
                        "--outdir", tmp], check=True, capture_output=True)
        names = sorted(p.name for p in (ROOT / "data").glob("*.csv"))
        same = all(filecmp.cmp(ROOT / "data" / n, Path(tmp) / n, shallow=False)
                   for n in names)
        check("V7 determinism (regenerated CSVs identical)", same)

    if FAILURES:
        print(f"\n{len(FAILURES)} verification(s) FAILED: {FAILURES}")
        sys.exit(1)
    print("\nAll verifications passed.")


if __name__ == "__main__":
    main()
