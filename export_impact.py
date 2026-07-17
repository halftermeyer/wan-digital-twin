#!/usr/bin/env python3
"""Export map/impact.geojson for a failure scenario.

Usage: python export_impact.py --failed PAR-CORE-01 [--failed NYC-CORE-01 ...]
Cities isolated from Paris HQ (Q2) are marked ISOLATED; inter-city links whose
either endpoint router failed are marked DOWN.
"""
import argparse
import json
import os
from pathlib import Path

from dotenv import find_dotenv, load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parent

load_dotenv(find_dotenv(usecwd=True))
NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")

Q2 = (ROOT / "cypher" / "demo" / "Q2_blast_radius.cypher").read_text().strip().rstrip(";")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--failed", action="append", default=[],
                        help="failed router hostname (repeatable, or comma-separated)")
    parser.add_argument("--out", default=str(ROOT / "map" / "impact.geojson"))
    args = parser.parse_args()
    failed = [h for arg in args.failed for h in arg.split(",") if h]

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    with driver.session() as s:
        isolated = {r["isolated_city"] for r in s.run(Q2, failed=failed)}
        cities = s.run("""
            MATCH (c:City)
            RETURN c.code AS code, c.name AS name, c.lat AS lat, c.lon AS lon
            ORDER BY c.code""").data()
        links = s.run("""
            MATCH (r1:Router)-[:LOCATED_IN]->(c1:City),
                  (r2:Router)-[:LOCATED_IN]->(c2:City),
                  (r1)-[k:CONNECTED_TO]->(r2)
            WHERE c1.code <> c2.code
            RETURN r1.hostname AS a, r2.hostname AS b,
                   c1.lat AS lat1, c1.lon AS lon1, c2.lat AS lat2, c2.lon AS lon2
            ORDER BY a, b""").data()
    driver.close()

    features = []
    for c in cities:
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
            "properties": {"code": c["code"], "name": c["name"],
                           "status": "ISOLATED" if c["code"] in isolated else "OK"},
        })
    for l in links:
        down = l["a"] in failed or l["b"] in failed
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString",
                         "coordinates": [[l["lon1"], l["lat1"]], [l["lon2"], l["lat2"]]]},
            "properties": {"a": l["a"], "b": l["b"],
                           "status": "DOWN" if down else "OK"},
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    geojson = json.dumps(
        {"type": "FeatureCollection",
         "properties": {"failed": failed, "isolated": sorted(isolated)},
         "features": features}, indent=2)
    out.write_text(geojson)
    # JS twin so index.html also works when opened directly (file:// blocks fetch)
    out.with_suffix(".geojson.js").write_text(f"window.IMPACT_DATA = {geojson};\n")
    print(f"Wrote {out} (+ .js fallback) — failed={failed or 'none'}, "
          f"isolated={sorted(isolated) or 'none'}")


if __name__ == "__main__":
    main()
