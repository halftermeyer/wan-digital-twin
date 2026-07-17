#!/usr/bin/env python3
"""Generate the deterministic WAN topology CSVs for the NDT demo.

All output is fully deterministic (seed=42): two consecutive runs produce
byte-identical CSVs. No external API calls; city coordinates are hardcoded.
"""
import argparse
import csv
import math
import random
from pathlib import Path

SEED = 42
ASN = 65001

# code, name, country, region, lat, lon
CITIES = [
    ("PAR", "Paris", "FR", "EMEA", 48.8566, 2.3522),
    ("LON", "London", "GB", "EMEA", 51.5074, -0.1278),
    ("FRA", "Frankfurt", "DE", "EMEA", 50.1109, 8.6821),
    ("MAD", "Madrid", "ES", "EMEA", 40.4168, -3.7038),
    ("MIL", "Milan", "IT", "EMEA", 45.4642, 9.1900),
    ("WAW", "Warsaw", "PL", "EMEA", 52.2297, 21.0122),
    ("IST", "Istanbul", "TR", "EMEA", 41.0082, 28.9784),
    ("JNB", "Johannesburg", "ZA", "EMEA", -26.2041, 28.0473),
    ("NYC", "New York", "US", "AMER", 40.7128, -74.0060),
    ("SAO", "Sao Paulo", "BR", "AMER", -23.5505, -46.6333),
    ("MEX", "Mexico City", "MX", "AMER", 19.4326, -99.1332),
    ("TOR", "Toronto", "CA", "AMER", 43.6532, -79.3832),
    ("SGP", "Singapore", "SG", "APAC", 1.3521, 103.8198),
    ("HKG", "Hong Kong", "HK", "APAC", 22.3193, 114.1694),
    ("TYO", "Tokyo", "JP", "APAC", 35.6762, 139.6503),
    ("SYD", "Sydney", "AU", "APAC", -33.8688, 151.2093),
    ("MUM", "Mumbai", "IN", "APAC", 19.0760, 72.8777),
    ("DXB", "Dubai", "AE", "APAC", 25.2048, 55.2708),
    ("SHA", "Shanghai", "CN", "APAC", 31.2304, 121.4737),
    ("SEL", "Seoul", "KR", "APAC", 37.5665, 126.9780),
]
CITY_BY_CODE = {c[0]: c for c in CITIES}

# Hub cities: 2 CORE routers each -> 12 CORE
HUB_CITIES = ["PAR", "LON", "NYC", "SGP", "HKG", "FRA"]

# Cities with 2 EDGE routers (the other 8 cities get 1) -> 24 + 8 = 32 EDGE.
# Spec fixes PAR, LON, NYC, SGP, TYO, FRA, SAO, MUM; HKG, DXB, SHA, SEL added
# to reach the mandated total of 12 CORE + 32 EDGE = 44 routers (see README).
TWO_EDGE_CITIES = [
    "PAR", "LON", "NYC", "SGP", "TYO", "FRA",
    "SAO", "MUM", "HKG", "DXB", "SHA", "SEL",
]

# Inter-city CORE backbone (city_a, city_b, medium); each pair is
# cross-connected twice: X-CORE-01<->Y-CORE-01 and X-CORE-02<->Y-CORE-02.
CORE_BACKBONE = [
    ("PAR", "LON", "fiber"),
    ("PAR", "FRA", "fiber"),
    ("LON", "FRA", "fiber"),
    ("NYC", "PAR", "submarine"),
    ("NYC", "LON", "submarine"),
    ("SGP", "HKG", "submarine"),
    ("SGP", "FRA", "submarine"),
    ("HKG", "NYC", "submarine"),
]

PROVIDERS = [("Lumen", 3356), ("Arelion", 1299), ("Tata", 6453)]

# EDGE-to-CORE links: submarine above this great-circle distance, else leased
SUBMARINE_KM = 3000.0


def haversine_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, [a[4], a[5], b[4], b[5]])
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * 6371.0 * math.asin(math.sqrt(h))


def latency_ms(city_a, city_b):
    return max(1, round(haversine_km(CITY_BY_CODE[city_a], CITY_BY_CODE[city_b]) / 100))


def build_routers():
    routers = []  # (hostname, role, os, city_code)
    for code in HUB_CITIES:
        for n in (1, 2):
            routers.append((f"{code}-CORE-{n:02d}", "CORE", "IOS-XR", code))
    for code, *_ in CITIES:
        count = 2 if code in TWO_EDGE_CITIES else 1
        for n in range(1, count + 1):
            routers.append((f"{code}-EDGE-{n:02d}", "EDGE", "IOS-XE", code))
    routers.sort(key=lambda r: r[0])
    return routers


def nearest_hub_cities(code, k=2):
    """Hub cities ordered by great-circle distance from `code` (own city first)."""
    ranked = sorted(
        HUB_CITIES,
        key=lambda h: (haversine_km(CITY_BY_CODE[code], CITY_BY_CODE[h]), h),
    )
    return ranked[:k]


def build_links(routers):
    """Return list of link dicts: (host_a, host_b, medium, latency_ms, capacity)."""
    links = []

    def add(host_a, host_b, medium, lat, cap):
        links.append({"a": host_a, "b": host_b, "medium": medium,
                      "latency_ms": lat, "capacity_gbps": cap})

    # 1a. Intra-city CORE pair links (fiber, 0.5 ms)
    for code in HUB_CITIES:
        add(f"{code}-CORE-01", f"{code}-CORE-02", "fiber", 0.5, 100)

    # 1b. Inter-city CORE backbone, both core pairs cross-connected
    for ca, cb, medium in CORE_BACKBONE:
        for n in (1, 2):
            add(f"{ca}-CORE-{n:02d}", f"{cb}-CORE-{n:02d}",
                medium, latency_ms(ca, cb), 100)

    # 2/3. EDGE homing (with the two deliberate SPOFs)
    def edge_medium(city_a, city_b):
        if city_a == city_b:
            return "leased"
        km = haversine_km(CITY_BY_CODE[city_a], CITY_BY_CODE[city_b])
        return "submarine" if km > SUBMARINE_KM else "leased"

    def edge_lat(city_a, city_b):
        return 1 if city_a == city_b else latency_ms(city_a, city_b)

    for hostname, role, _os, city in routers:
        if role != "EDGE":
            continue
        if hostname == "JNB-EDGE-01":
            # SPOF #1: Johannesburg single-homed to PAR-CORE-01
            add(hostname, "PAR-CORE-01",
                edge_medium("JNB", "PAR"), edge_lat("JNB", "PAR"), 10)
            continue
        if city == "SAO":
            # SPOF #2: both SAO edges homed only to the NYC core pair,
            # each dual-homed to both NYC cores (keeps degree >= 2 while
            # making {NYC-CORE-01, NYC-CORE-02} a 2-cut isolating SAO)
            for n in (1, 2):
                add(hostname, f"NYC-CORE-{n:02d}",
                    edge_medium("SAO", "NYC"), edge_lat("SAO", "NYC"), 10)
            continue
        # Dual-homed to the 2 nearest CORE cities (different cities), picking
        # the core router whose index matches the edge index (01->01, 02->02)
        idx = int(hostname.rsplit("-", 1)[1])
        for hub in nearest_hub_cities(city, k=2):
            add(hostname, f"{hub}-CORE-{idx:02d}",
                edge_medium(city, hub), edge_lat(city, hub), 10)

    return links


def allocate_interfaces(routers, links):
    """One interface per link endpoint; sequential names per router."""
    role_of = {r[0]: r[1] for r in routers}
    counters = {r[0]: 0 for r in routers}
    interfaces = []  # (id, hostname, name, capacity_gbps)
    link_rows = []

    def new_iface(hostname, capacity):
        counters[hostname] += 1
        n = counters[hostname]
        name = (f"HundredGigE0/0/0/{n}" if role_of[hostname] == "CORE"
                else f"GigabitEthernet0/0/{n}")
        iface_id = f"{hostname}:{name}"
        interfaces.append((iface_id, hostname, name, capacity))
        return iface_id

    for link in links:
        ia = new_iface(link["a"], link["capacity_gbps"])
        ib = new_iface(link["b"], link["capacity_gbps"])
        link_rows.append((ia, ib, link["medium"],
                          link["latency_ms"], link["capacity_gbps"]))
    return interfaces, link_rows


def build_bgp(routers, links):
    """One iBGP row per adjacent router pair; eBGP CORE->2 providers round-robin."""
    pairs = sorted({tuple(sorted((l["a"], l["b"]))) for l in links})
    rows = [(a, b, "iBGP") for a, b in pairs]

    rng = random.Random(SEED)
    offset = rng.randrange(len(PROVIDERS))  # seeded round-robin start
    cores = sorted(r[0] for r in routers if r[1] == "CORE")
    for i, hostname in enumerate(cores):
        for j in range(2):  # exactly 2 of the 3 providers
            rows.append((hostname, PROVIDERS[(offset + i + j) % 3][0], "eBGP"))
    return rows


def write_csv(path, header, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--outdir", default="data")
    args = parser.parse_args()
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    routers = build_routers()
    links = build_links(routers)
    interfaces, link_rows = allocate_interfaces(routers, links)
    bgp_rows = build_bgp(routers, links)

    write_csv(outdir / "cities.csv",
              ["code", "name", "country", "region", "lat", "lon"], CITIES)
    write_csv(outdir / "routers.csv",
              ["hostname", "role", "os", "asn", "loopback_ip", "status", "city_code"],
              [(h, role, os_, ASN, f"10.255.0.{i + 1}", "UP", city)
               for i, (h, role, os_, city) in enumerate(routers)])
    write_csv(outdir / "interfaces.csv",
              ["id", "hostname", "name", "capacity_gbps", "status"],
              [(i, h, n, c, "UP") for i, h, n, c in interfaces])
    write_csv(outdir / "links.csv",
              ["interface_a", "interface_b", "medium", "latency_ms", "capacity_gbps"],
              link_rows)
    write_csv(outdir / "bgp_sessions.csv", ["router", "peer", "type"], bgp_rows)
    write_csv(outdir / "providers.csv", ["name", "asn"], PROVIDERS)

    n_core = sum(1 for r in routers if r[1] == "CORE")
    print(f"Generated {len(routers)} routers ({n_core} CORE), "
          f"{len(link_rows)} links, {len(interfaces)} interfaces -> {outdir}/")


if __name__ == "__main__":
    main()
