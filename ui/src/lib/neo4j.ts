import neo4j, { Driver, Session, Record as Neo4jRecord, type Integer } from "neo4j-driver";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      import.meta.env.VITE_NEO4J_URI || "bolt://127.0.0.1:7687",
      neo4j.auth.basic(
        import.meta.env.VITE_NEO4J_USER || "neo4j",
        import.meta.env.VITE_NEO4J_PASSWORD || ""
      )
    );
  }
  return driver;
}

// ── Query audit log ────────────────────────────────────────────

export interface QueryLogEntry {
  id: number;
  timestamp: Date;
  cypher: string;
  params: Record<string, unknown>;
  durationMs: number;
  rowCount: number;
  results?: unknown[];
  error?: string;
  group?: string;
}

export interface QueryGroup {
  label: string;
  entries: QueryLogEntry[];
  totalMs: number;
  totalRows: number;
  hasError: boolean;
}

let _logCounter = 0;
let _queryLog: QueryLogEntry[] = [];
let _currentGroup: string | null = null;
const _listeners: Set<() => void> = new Set();

export function getQueryLog(): QueryLogEntry[] {
  return _queryLog;
}

/** Group subsequent queries under a label until endGroup() is called */
export function beginGroup(label: string): void {
  _currentGroup = label;
}

export function endGroup(): void {
  _currentGroup = null;
}

/** Run an async function with all its queries grouped under a label */
export async function withGroup<T>(label: string, fn: () => Promise<T>): Promise<T> {
  beginGroup(label);
  try {
    return await fn();
  } finally {
    endGroup();
  }
}

/** Return log entries organized into groups (ungrouped entries get their own group) */
export function getGroupedLog(): QueryGroup[] {
  const groups: QueryGroup[] = [];
  let currentLabel: string | null = null;
  let currentEntries: QueryLogEntry[] = [];

  const flush = () => {
    if (currentEntries.length > 0) {
      groups.push({
        label: currentLabel || currentEntries[0].cypher.split("\n")[0].trim().substring(0, 60),
        entries: currentEntries,
        totalMs: currentEntries.reduce((s, e) => s + e.durationMs, 0),
        totalRows: currentEntries.reduce((s, e) => s + e.rowCount, 0),
        hasError: currentEntries.some((e) => e.error),
      });
      currentEntries = [];
    }
  };

  for (const entry of _queryLog) {
    if (entry.group !== currentLabel) {
      flush();
      currentLabel = entry.group || null;
    }
    currentEntries.push(entry);
  }
  flush();

  return groups;
}

export function clearQueryLog(): void {
  _queryLog = [];
  _notifyListeners();
}

export function onQueryLogChange(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

function _notifyListeners() {
  _listeners.forEach((fn) => fn());
}

// ── Run query with logging ─────────────────────────────────────

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  database?: string,
  timeoutSeconds?: number
): Promise<T[]> {
  const session: Session = getDriver().session({
    database: database || import.meta.env.VITE_NEO4J_DATABASE || "neo4j",
  });
  const start = performance.now();
  const entryId = ++_logCounter;

  try {
    // neo4j-driver's TransactionConfig.timeout is in MILLISECONDS (Bolt's tx_timeout
    // field) — this function's own param is named in seconds for readability at call
    // sites, so convert here rather than at every caller.
    const result = await session.run(
      cypher,
      params,
      timeoutSeconds ? { timeout: timeoutSeconds * 1000 } : undefined
    );
    const rows = result.records.map((r: Neo4jRecord) => {
      const obj: Record<string, unknown> = {};
      r.keys.forEach((key) => {
        const val = r.get(key);
        obj[key as string] = toJS(val);
      });
      return obj as T;
    });

    _queryLog = [
      ..._queryLog,
      {
        id: entryId,
        timestamp: new Date(),
        cypher: cypher.trim(),
        params,
        durationMs: Math.round(performance.now() - start),
        rowCount: rows.length,
        results: rows.slice(0, 20) as unknown[],
        group: _currentGroup || undefined,
      },
    ];
    _notifyListeners();

    return rows;
  } catch (e: unknown) {
    _queryLog = [
      ..._queryLog,
      {
        id: entryId,
        timestamp: new Date(),
        cypher: cypher.trim(),
        params,
        durationMs: Math.round(performance.now() - start),
        rowCount: 0,
        error: (e as Error).message,
        group: _currentGroup || undefined,
      },
    ];
    _notifyListeners();
    throw e;
  } finally {
    await session.close();
  }
}

// Convert Neo4j types to plain JS
function toJS(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return val.toNumber();
  if (typeof val === "object" && val !== null) {
    if (Array.isArray(val)) return val.map(toJS);
    if ("low" in val && "high" in val) return neo4j.integer.toNumber(val as Integer);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = toJS(v);
    }
    return out;
  }
  return val;
}
