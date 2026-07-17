import { useEffect, useState } from "react";
import type { TopologyLink, TopologyNode } from "../lib/queries";

// Hand-rolled SVG (same rationale as the reference demo's DecisionGraph): the
// topology has a natural deterministic layout — geographic coordinates — so we
// project lat/lon directly instead of a force layout. Zero rendering surprises,
// always readable on a projector.
//
// The land-mass backdrop is a small (~250KB) world outline bundled as a static
// asset and fetched same-origin, once, at module scope — no live map tiles, no
// runtime internet dependency, consistent with this demo's "no external API
// calls at runtime" constraint. Trades exact cartographic polish for reliability
// in a room with unknown wifi.

const WIDTH = 1000;
const HEIGHT = 520;
const PAD = 30;

function project(lat: number, lon: number): { x: number; y: number } {
  const x = PAD + ((lon + 180) / 360) * (WIDTH - 2 * PAD);
  const y = PAD + ((90 - lat) / 180) * (HEIGHT - 2 * PAD);
  return { x, y };
}

function ringToPath(ring: number[][]): string {
  return ring
    .map(([lon, lat], i) => {
      const { x, y } = project(lat, lon);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ") + " Z";
}

type LandFeature = { type: "Polygon" | "MultiPolygon"; coordinates: number[][][] | number[][][][] };

let landPromise: Promise<string[]> | null = null;

function loadLandPaths(): Promise<string[]> {
  if (!landPromise) {
    landPromise = fetch("/world-land.geojson")
      .then((r) => r.json())
      .then((geojson: { features: { geometry: LandFeature }[] }) => {
        const paths: string[] = [];
        for (const f of geojson.features) {
          const geom = f.geometry;
          const polygons = geom.type === "Polygon" ? [geom.coordinates as number[][][]] : (geom.coordinates as number[][][][]);
          for (const poly of polygons) {
            for (const ring of poly) {
              paths.push(ringToPath(ring));
            }
          }
        }
        return paths;
      })
      .catch(() => []); // demo must still render if the asset is missing
  }
  return landPromise;
}

const ROLE_COLOR: Record<string, string> = {
  CORE: "#0b297d",
  EDGE: "#006fd6",
};

interface Props {
  nodes: TopologyNode[];
  links: TopologyLink[];
  failed?: string[];
  isolatedCities?: string[];
  highlightPath?: string[];
}

export default function NetworkGraph({
  nodes,
  links,
  failed = [],
  isolatedCities = [],
  highlightPath = [],
}: Props) {
  const [landPaths, setLandPaths] = useState<string[]>([]);

  useEffect(() => {
    loadLandPaths().then(setLandPaths);
  }, []);

  if (nodes.length === 0) {
    return (
      <div
        className="graph-container"
        style={{ display: "flex", alignItems: "center", justifyContent: "center", color: "#999" }}
      >
        No topology data
      </div>
    );
  }

  const pos: Record<string, { x: number; y: number }> = {};
  nodes.forEach((n) => {
    pos[n.hostname] = project(n.lat, n.lon);
  });

  const failedSet = new Set(failed);
  const isolatedSet = new Set(isolatedCities);
  const highlightSet = new Set(highlightPath);
  const highlightEdges = new Set(
    highlightPath.slice(0, -1).map((h, i) => [h, highlightPath[i + 1]].sort().join("|"))
  );

  return (
    <div className="graph-container" style={{ height: "auto" }}>
      <div
        style={{
          padding: "8px 12px",
          background: "#f5f5f5",
          borderBottom: "1px solid #e0e0e0",
          display: "flex",
          gap: 16,
          fontSize: 12,
          flexWrap: "wrap",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: ROLE_COLOR.CORE, display: "inline-block" }} />
          CORE
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: ROLE_COLOR.EDGE, display: "inline-block" }} />
          EDGE
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#c62828", display: "inline-block" }} />
          Failed / isolated
        </span>
        {highlightPath.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 14, height: 3, background: "#00b4d8", display: "inline-block" }} />
            Resolved path
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block", background: "#eaf3fa" }}
      >
        <g>
          {landPaths.map((d, i) => (
            <path key={i} d={d} fill="#dbe6d9" stroke="#c5d6c2" strokeWidth={0.5} />
          ))}
        </g>

        {links.map((l, i) => {
          const from = pos[l.a];
          const to = pos[l.b];
          if (!from || !to) return null;
          const isFailedLink = failedSet.has(l.a) || failedSet.has(l.b);
          const isHighlighted = highlightEdges.has([l.a, l.b].sort().join("|"));
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={isHighlighted ? "#00b4d8" : isFailedLink ? "#e57373" : "#607d8b"}
              strokeWidth={isHighlighted ? 3 : 1}
              strokeDasharray={isFailedLink && !isHighlighted ? "4 3" : undefined}
              opacity={isHighlighted ? 1 : 0.75}
            />
          );
        })}

        {nodes.map((n) => {
          const p = pos[n.hostname];
          const isFailed = failedSet.has(n.hostname);
          const isIsolated = isolatedSet.has(n.city);
          const isHighlighted = highlightSet.has(n.hostname);
          const r = n.role === "CORE" ? 6 : 4;
          const color = isFailed || isIsolated ? "#c62828" : ROLE_COLOR[n.role] ?? "#999";
          return (
            <g key={n.hostname}>
              <circle
                cx={p.x}
                cy={p.y}
                r={isHighlighted ? r + 2 : r}
                fill={color}
                stroke={isHighlighted ? "#00b4d8" : "white"}
                strokeWidth={isHighlighted ? 2 : 1}
              />
            </g>
          );
        })}

        {/* City labels, deduplicated */}
        {Array.from(new Set(nodes.map((n) => n.city))).map((city) => {
          const first = nodes.find((n) => n.city === city);
          if (!first) return null;
          const p = pos[first.hostname];
          return (
            <text
              key={city}
              x={p.x}
              y={p.y - 10}
              textAnchor="middle"
              fontSize={10}
              fontWeight={isolatedSet.has(city) ? 700 : 500}
              fill={isolatedSet.has(city) ? "#c62828" : "#37474f"}
              style={{ paintOrder: "stroke", stroke: "#eaf3fa", strokeWidth: 3 }}
            >
              {city}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
