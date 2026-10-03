import { join } from "node:path";
import type { Client } from "@libsql/client";
import { Data, Effect, type Cause } from "effect";

import {
  formatExecuteResult,
  formatPausedExecution,
  type ExecutionEngine,
  type ExecutionResult,
  type ToolCallEvent,
} from "@executor-js/execution";
import { parseToolAddress, type Executor } from "@executor-js/sdk";

import { resolveExecutorDataDir } from "./auth";
import { executeSql, openLocalLibsql, queryFirst, queryRows } from "./db/libsql";

// ---------------------------------------------------------------------------
// Local usage statistics: what agents did through this daemon — executions,
// sandbox tool calls per integration/tool, which MCP clients, and estimates of
// the context tokens Executor kept out of those clients' prompts versus what
// they actually consumed through it.
//
// Stored ONLY on this machine, in `<data dir>/stats.db` (a separate libSQL
// file from the executor DB, so it can be deleted freely). Never records tool
// arguments, results, code, or error messages: paths, outcomes, error codes,
// timings, and character-count token estimates only. Served to the web UI's
// Statistics page by `GET /api/stats` (see `makeStatsRequestHandler`).
//
// Writes are fire-and-forget: a stats failure is logged and dropped, and no
// execution ever waits on — or can be failed by — statistics.
// ---------------------------------------------------------------------------

export type StatsPlane = "mcp" | "api";
export type StatsRange = "24h" | "7d" | "30d" | "all";
type ExecutionOutcome = "ok" | "error" | "paused";

const RANGE_MS: Readonly<Record<Exclude<StatsRange, "all">, number>> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Agent label for the HTTP executions API (web console, `executor call`). */
export const API_AGENT = "Executor API";

export interface StatsSessionInfo {
  /** MCP `clientInfo.name` (e.g. `claude-code`), or {@link API_AGENT}. */
  readonly agent: string;
  readonly agentVersion: string | null;
  readonly plane: StatsPlane;
  readonly toolkit: boolean;
}

export interface CatalogEstimate {
  readonly tools: number;
  readonly integrations: number;
  /** Estimated tokens to send every tool definition to a client directly. */
  readonly tokens: number;
}

/** One tool definition as an MCP client would load it into context. */
export interface ToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

/** ≈ tokens of a text: characters / 4. */
const estimateTokens = (characters: number): number => Math.round(characters / 4);

/** ≈ tokens of a tool-definition list as a client would load it. */
export const estimateDefinitionTokens = (definitions: ReadonlyArray<ToolDefinition>): number =>
  estimateTokens(
    JSON.stringify(
      definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ).length,
  );

/** What listing an executor's agent-visible catalog directly would cost. */
export const estimateCatalog = (
  executor: Pick<Executor, "tools" | "integrations">,
): Promise<CatalogEstimate> =>
  Effect.runPromise(
    Effect.all([executor.tools.list(), executor.integrations.list()]).pipe(
      Effect.map(([tools, integrations]) => ({
        tools: tools.length,
        integrations: integrations.length,
        tokens: estimateDefinitionTokens(tools),
      })),
    ),
  );

/** The integration a sandbox tool path belongs to: the address's integration
 *  for connection tools (`github.org.main.getRepo`), else the first segment
 *  (static tools such as `executor.integrations.list`). */
const integrationOfPath = (path: string): string =>
  parseToolAddress(`tools.${path}`)?.integration ?? path.split(".")[0] ?? path;

export interface ExecutionRecord {
  readonly kind: "execute" | "resume";
  readonly outcome: ExecutionOutcome;
  readonly durationMs: number;
  /** ≈ tokens of the code the agent sent (0 for `resume`). */
  readonly codeTokens: number;
  /** ≈ tokens of the result text returned to the agent. */
  readonly resultTokens: number;
}

export interface StatsSession {
  readonly recordToolCall: (event: ToolCallEvent) => void;
  readonly recordExecution: (record: ExecutionRecord) => void;
  /** The session's first `tools/list`: Executor's own tool definitions vs the
   *  catalog the client would otherwise have loaded. Later listings are ignored. */
  readonly recordToolsListed: (exposedTokens: number, catalog: CatalogEstimate) => void;
}

class StatsWriteError extends Data.TaggedError("StatsWriteError")<{
  readonly cause: unknown;
}> {}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stats_session (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    agent_version TEXT,
    plane TEXT NOT NULL,
    toolkit INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    tokens_baseline INTEGER,
    tokens_exposed INTEGER,
    catalog_tools INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS stats_execution (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS stats_execution_ts ON stats_execution (ts)`,
  `CREATE TABLE IF NOT EXISTS stats_tool_call (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    integration TEXT NOT NULL,
    ok INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    error_code TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS stats_tool_call_ts ON stats_tool_call (ts)`,
] as const;

/** Applied in order past `PRAGMA user_version`; never edit, only append. */
const MIGRATIONS = [
  `ALTER TABLE stats_execution ADD COLUMN code_tokens INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE stats_execution ADD COLUMN result_tokens INTEGER NOT NULL DEFAULT 0`,
] as const;

export interface StatsSnapshot {
  readonly range: StatsRange;
  readonly since: number | null;
  readonly generatedAt: number;
  readonly totals: {
    readonly sessions: number;
    readonly executions: number;
    readonly executionErrors: number;
    readonly pausedForApproval: number;
    readonly toolCalls: number;
    readonly toolCallErrors: number;
    readonly discoveryCalls: number;
    readonly tokensBaseline: number;
    readonly tokensExposed: number;
    readonly tokensSaved: number;
    readonly codeTokens: number;
    readonly resultTokens: number;
    readonly avgExecutionMs: number | null;
    readonly avgToolCallMs: number | null;
  };
  readonly catalog: CatalogEstimate;
  readonly agents: ReadonlyArray<AgentStats>;
  readonly integrations: ReadonlyArray<{
    readonly integration: string;
    readonly toolCalls: number;
    readonly errors: number;
    readonly avgDurationMs: number;
    readonly lastUsed: number;
  }>;
  readonly tools: ReadonlyArray<{
    readonly path: string;
    readonly integration: string;
    readonly calls: number;
    readonly errors: number;
    readonly avgDurationMs: number;
    readonly lastUsed: number;
  }>;
  readonly timeline: ReadonlyArray<TimelineBucket>;
  readonly errorCodes: ReadonlyArray<{ readonly code: string; readonly count: number }>;
  readonly recent: ReadonlyArray<{
    readonly ts: number;
    readonly agent: string;
    readonly path: string;
    readonly kind: "tool" | "discovery";
    readonly ok: boolean;
    readonly durationMs: number;
    readonly errorCode: string | null;
  }>;
}

interface AgentStats {
  agent: string;
  version: string | null;
  plane: StatsPlane;
  sessions: number;
  executions: number;
  executionErrors: number;
  toolCalls: number;
  tokensSaved: number;
  codeTokens: number;
  resultTokens: number;
  lastSeen: number;
}

interface TimelineBucket {
  bucket: number;
  executions: number;
  executionErrors: number;
  pausedForApproval: number;
  toolCalls: number;
  toolCallErrors: number;
  discoveryCalls: number;
  errors: number;
  tokensBaseline: number;
  tokensExposed: number;
  tokensSaved: number;
  codeTokens: number;
  resultTokens: number;
  avgExecutionMs: number | null;
  avgToolCallMs: number | null;
}

export interface LocalStats {
  /** Start an agent session. Its row is written on first activity, so idle
   *  connections and an unused API plane leave no trace. `info` is read then,
   *  which lets an MCP session resolve its client after `initialize`. */
  readonly session: (info: () => StatsSessionInfo) => StatsSession;
  readonly snapshot: (range: StatsRange, catalog: CatalogEstimate) => Promise<StatsSnapshot>;
  readonly close: () => Promise<void>;
}

/** Per-session tokens kept out of context; never negative. */
const SAVED_SQL = `MAX(COALESCE(tokens_baseline, 0) - COALESCE(tokens_exposed, 0), 0)`;

export const makeLocalStats = (path: string): LocalStats => {
  let client: Promise<Client> | null = null;
  const db = (): Promise<Client> => {
    client ??= openLocalLibsql(path).then(async (opened) => {
      for (const statement of SCHEMA) await executeSql(opened, statement);
      const applied = (await queryFirst<{ user_version: number }>(opened, "PRAGMA user_version"))
        ?.user_version;
      for (const statement of MIGRATIONS.slice(applied ?? 0)) await executeSql(opened, statement);
      await executeSql(opened, `PRAGMA user_version = ${MIGRATIONS.length}`);
      return opened;
    });
    return client;
  };

  const write = (sql: string, args: ReadonlyArray<string | number | null>): void => {
    Effect.runFork(
      Effect.tryPromise({
        try: async () => executeSql(await db(), sql, [...args]),
        catch: (cause) => new StatsWriteError({ cause }),
      }).pipe(
        Effect.tapCause((cause) => Effect.logWarning("[stats] write failed", cause)),
        Effect.ignore,
      ),
    );
  };

  const session = (info: () => StatsSessionInfo): StatsSession => {
    const id = crypto.randomUUID();
    let persisted = false;
    let listed = false;
    const ensureRow = (): void => {
      if (persisted) return;
      persisted = true;
      const { agent, agentVersion, plane, toolkit } = info();
      write(
        `INSERT OR IGNORE INTO stats_session (id, agent, agent_version, plane, toolkit, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, agent, agentVersion, plane, toolkit ? 1 : 0, Date.now()],
      );
    };
    return {
      recordToolCall: (event) => {
        ensureRow();
        write(
          `INSERT INTO stats_tool_call
             (session_id, ts, path, kind, integration, ok, duration_ms, error_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            Date.now(),
            event.path,
            event.kind,
            integrationOfPath(event.path),
            event.ok ? 1 : 0,
            event.durationMs,
            event.errorCode,
          ],
        );
      },
      recordExecution: (record) => {
        ensureRow();
        write(
          `INSERT INTO stats_execution
             (session_id, ts, kind, outcome, duration_ms, code_tokens, result_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            Date.now(),
            record.kind,
            record.outcome,
            record.durationMs,
            record.codeTokens,
            record.resultTokens,
          ],
        );
      },
      recordToolsListed: (exposedTokens, catalog) => {
        if (listed) return;
        listed = true;
        ensureRow();
        write(
          `UPDATE stats_session SET tokens_baseline = ?, tokens_exposed = ?, catalog_tools = ?
           WHERE id = ?`,
          [catalog.tokens, exposedTokens, catalog.tools, id],
        );
      },
    };
  };

  const snapshot = async (range: StatsRange, catalog: CatalogEstimate): Promise<StatsSnapshot> => {
    const conn = await db();
    const now = Date.now();
    const since = range === "all" ? null : now - RANGE_MS[range];
    const from = since ?? 0;

    // Buckets in the machine's local time, so "a day" matches the user's day.
    const bucketMs = range === "24h" ? HOUR_MS : DAY_MS;
    const offsetMs = -new Date(now).getTimezoneOffset() * 60 * 1000;
    const bucketOf = (ts: number): number =>
      Math.floor((ts + offsetMs) / bucketMs) * bucketMs - offsetMs;
    const bucketSql = (column: string) =>
      `(((${column} + ${offsetMs}) / ${bucketMs}) * ${bucketMs} - ${offsetMs})`;

    const [
      sessionTotals,
      executionTotals,
      toolTotals,
      agentSessions,
      agentExecutions,
      agentToolCalls,
      integrations,
      tools,
      errorCodes,
      recent,
      sessionBuckets,
      executionBuckets,
      toolBuckets,
      firstActivity,
    ] = await Promise.all([
      queryFirst<{ sessions: number; baseline: number; exposed: number; saved: number }>(
        conn,
        `SELECT
           COALESCE(SUM(plane = 'mcp'), 0) AS sessions,
           COALESCE(SUM(tokens_baseline), 0) AS baseline,
           COALESCE(SUM(tokens_exposed), 0) AS exposed,
           COALESCE(SUM(${SAVED_SQL}), 0) AS saved
         FROM stats_session WHERE started_at >= ?`,
        [from],
      ),
      queryFirst<{
        executions: number;
        errors: number;
        paused: number;
        code: number;
        result: number;
        avg_ms: number | null;
      }>(
        conn,
        `SELECT
           COALESCE(SUM(kind = 'execute'), 0) AS executions,
           COALESCE(SUM(outcome = 'error'), 0) AS errors,
           COALESCE(SUM(kind = 'execute' AND outcome = 'paused'), 0) AS paused,
           COALESCE(SUM(code_tokens), 0) AS code,
           COALESCE(SUM(result_tokens), 0) AS result,
           AVG(CASE WHEN kind = 'execute' THEN duration_ms END) AS avg_ms
         FROM stats_execution WHERE ts >= ?`,
        [from],
      ),
      queryFirst<{
        tool_calls: number;
        tool_errors: number;
        discovery: number;
        avg_ms: number | null;
      }>(
        conn,
        `SELECT
           COALESCE(SUM(kind = 'tool'), 0) AS tool_calls,
           COALESCE(SUM(kind = 'tool' AND ok = 0), 0) AS tool_errors,
           COALESCE(SUM(kind = 'discovery'), 0) AS discovery,
           AVG(CASE WHEN kind = 'tool' THEN duration_ms END) AS avg_ms
         FROM stats_tool_call WHERE ts >= ?`,
        [from],
      ),
      queryRows<{
        agent: string;
        plane: StatsPlane;
        version: string | null;
        sessions: number;
        saved: number;
        last_seen: number;
      }>(
        conn,
        `SELECT agent, plane,
           (SELECT s2.agent_version FROM stats_session s2
             WHERE s2.agent = s.agent AND s2.plane = s.plane
             ORDER BY s2.started_at DESC LIMIT 1) AS version,
           COUNT(*) AS sessions,
           COALESCE(SUM(${SAVED_SQL}), 0) AS saved,
           MAX(started_at) AS last_seen
         FROM stats_session s WHERE started_at >= ? GROUP BY agent, plane`,
        [from],
      ),
      queryRows<{
        agent: string;
        plane: StatsPlane;
        version: string | null;
        executions: number;
        errors: number;
        code: number;
        result: number;
        last_seen: number;
      }>(
        conn,
        `SELECT s.agent AS agent, s.plane AS plane, MAX(s.agent_version) AS version,
           COALESCE(SUM(e.kind = 'execute'), 0) AS executions,
           COALESCE(SUM(e.outcome = 'error'), 0) AS errors,
           COALESCE(SUM(e.code_tokens), 0) AS code,
           COALESCE(SUM(e.result_tokens), 0) AS result,
           MAX(e.ts) AS last_seen
         FROM stats_execution e JOIN stats_session s ON s.id = e.session_id
         WHERE e.ts >= ? GROUP BY s.agent, s.plane`,
        [from],
      ),
      queryRows<{
        agent: string;
        plane: StatsPlane;
        version: string | null;
        tool_calls: number;
        last_seen: number;
      }>(
        conn,
        `SELECT s.agent AS agent, s.plane AS plane, MAX(s.agent_version) AS version,
           COALESCE(SUM(t.kind = 'tool'), 0) AS tool_calls,
           MAX(t.ts) AS last_seen
         FROM stats_tool_call t JOIN stats_session s ON s.id = t.session_id
         WHERE t.ts >= ? GROUP BY s.agent, s.plane`,
        [from],
      ),
      queryRows<{
        integration: string;
        calls: number;
        errors: number;
        avg_ms: number;
        last_used: number;
      }>(
        conn,
        `SELECT integration, COUNT(*) AS calls, SUM(ok = 0) AS errors,
           AVG(duration_ms) AS avg_ms, MAX(ts) AS last_used
         FROM stats_tool_call WHERE kind = 'tool' AND ts >= ?
         GROUP BY integration ORDER BY calls DESC`,
        [from],
      ),
      queryRows<{
        path: string;
        integration: string;
        calls: number;
        errors: number;
        avg_ms: number;
        last_used: number;
      }>(
        conn,
        `SELECT path, integration, COUNT(*) AS calls, SUM(ok = 0) AS errors,
           AVG(duration_ms) AS avg_ms, MAX(ts) AS last_used
         FROM stats_tool_call WHERE kind = 'tool' AND ts >= ?
         GROUP BY path ORDER BY calls DESC LIMIT 25`,
        [from],
      ),
      queryRows<{ code: string; count: number }>(
        conn,
        `SELECT error_code AS code, COUNT(*) AS count
         FROM stats_tool_call WHERE ok = 0 AND error_code IS NOT NULL AND ts >= ?
         GROUP BY error_code ORDER BY count DESC LIMIT 10`,
        [from],
      ),
      queryRows<{
        ts: number;
        agent: string | null;
        path: string;
        kind: "tool" | "discovery";
        ok: number;
        duration_ms: number;
        error_code: string | null;
      }>(
        conn,
        `SELECT t.ts AS ts, s.agent AS agent, t.path AS path, t.kind AS kind, t.ok AS ok,
           t.duration_ms AS duration_ms, t.error_code AS error_code
         FROM stats_tool_call t LEFT JOIN stats_session s ON s.id = t.session_id
         WHERE t.ts >= ? ORDER BY t.ts DESC LIMIT 50`,
        [from],
      ),
      queryRows<{ bucket: number; baseline: number; exposed: number; saved: number }>(
        conn,
        `SELECT ${bucketSql("started_at")} AS bucket,
           COALESCE(SUM(tokens_baseline), 0) AS baseline,
           COALESCE(SUM(tokens_exposed), 0) AS exposed,
           COALESCE(SUM(${SAVED_SQL}), 0) AS saved
         FROM stats_session WHERE started_at >= ? GROUP BY bucket`,
        [from],
      ),
      queryRows<{
        bucket: number;
        executions: number;
        errors: number;
        paused: number;
        code: number;
        result: number;
        avg_ms: number | null;
      }>(
        conn,
        `SELECT ${bucketSql("ts")} AS bucket,
           SUM(kind = 'execute') AS executions,
           SUM(outcome = 'error') AS errors,
           SUM(kind = 'execute' AND outcome = 'paused') AS paused,
           SUM(code_tokens) AS code,
           SUM(result_tokens) AS result,
           AVG(CASE WHEN kind = 'execute' THEN duration_ms END) AS avg_ms
         FROM stats_execution WHERE ts >= ? GROUP BY bucket`,
        [from],
      ),
      queryRows<{
        bucket: number;
        tool_calls: number;
        errors: number;
        discovery: number;
        avg_ms: number | null;
      }>(
        conn,
        `SELECT ${bucketSql("ts")} AS bucket,
           SUM(kind = 'tool') AS tool_calls,
           SUM(kind = 'tool' AND ok = 0) AS errors,
           SUM(kind = 'discovery') AS discovery,
           AVG(CASE WHEN kind = 'tool' THEN duration_ms END) AS avg_ms
         FROM stats_tool_call WHERE ts >= ? GROUP BY bucket`,
        [from],
      ),
      queryFirst<{ first: number | null }>(
        conn,
        `SELECT MIN(first) AS first FROM (
           SELECT MIN(ts) AS first FROM stats_execution
           UNION ALL SELECT MIN(ts) AS first FROM stats_tool_call
           UNION ALL SELECT MIN(started_at) AS first FROM stats_session)`,
      ),
    ]);

    // One row per (plane, agent), merged from the three per-table aggregates.
    const agents = new Map<string, AgentStats>();
    const agentFor = (row: {
      agent: string;
      plane: StatsPlane;
      version: string | null;
      last_seen: number;
    }): AgentStats => {
      const key = `${row.plane}\u0000${row.agent}`;
      const entry = agents.get(key) ?? {
        agent: row.agent,
        version: null,
        plane: row.plane,
        sessions: 0,
        executions: 0,
        executionErrors: 0,
        toolCalls: 0,
        tokensSaved: 0,
        codeTokens: 0,
        resultTokens: 0,
        lastSeen: 0,
      };
      entry.version ??= row.version;
      entry.lastSeen = Math.max(entry.lastSeen, row.last_seen);
      agents.set(key, entry);
      return entry;
    };
    for (const row of agentSessions) {
      const entry = agentFor(row);
      entry.version = row.version ?? entry.version;
      entry.sessions = row.sessions;
      entry.tokensSaved = row.saved;
    }
    for (const row of agentExecutions) {
      const entry = agentFor(row);
      entry.executions = row.executions;
      entry.executionErrors = row.errors;
      entry.codeTokens = row.code;
      entry.resultTokens = row.result;
    }
    for (const row of agentToolCalls) agentFor(row).toolCalls = row.tool_calls;

    // Zero-filled buckets, oldest first; "all" starts at the first activity.
    const timeline = new Map<number, TimelineBucket>();
    for (
      let bucket = bucketOf(since ?? firstActivity?.first ?? now);
      bucket <= now;
      bucket += bucketMs
    ) {
      timeline.set(bucket, {
        bucket,
        executions: 0,
        executionErrors: 0,
        pausedForApproval: 0,
        toolCalls: 0,
        toolCallErrors: 0,
        discoveryCalls: 0,
        errors: 0,
        tokensBaseline: 0,
        tokensExposed: 0,
        tokensSaved: 0,
        codeTokens: 0,
        resultTokens: 0,
        avgExecutionMs: null,
        avgToolCallMs: null,
      });
    }
    for (const row of sessionBuckets) {
      const entry = timeline.get(row.bucket);
      if (!entry) continue;
      entry.tokensBaseline = row.baseline;
      entry.tokensExposed = row.exposed;
      entry.tokensSaved = row.saved;
    }
    for (const row of executionBuckets) {
      const entry = timeline.get(row.bucket);
      if (!entry) continue;
      entry.executions = row.executions;
      entry.executionErrors = row.errors;
      entry.pausedForApproval = row.paused;
      entry.codeTokens = row.code;
      entry.resultTokens = row.result;
      entry.avgExecutionMs = row.avg_ms === null ? null : Math.round(row.avg_ms);
      entry.errors += row.errors;
    }
    for (const row of toolBuckets) {
      const entry = timeline.get(row.bucket);
      if (!entry) continue;
      entry.toolCalls = row.tool_calls;
      entry.toolCallErrors = row.errors;
      entry.discoveryCalls = row.discovery;
      entry.avgToolCallMs = row.avg_ms === null ? null : Math.round(row.avg_ms);
      entry.errors += row.errors;
    }

    return {
      range,
      since,
      generatedAt: now,
      totals: {
        sessions: sessionTotals?.sessions ?? 0,
        executions: executionTotals?.executions ?? 0,
        executionErrors: executionTotals?.errors ?? 0,
        pausedForApproval: executionTotals?.paused ?? 0,
        toolCalls: toolTotals?.tool_calls ?? 0,
        toolCallErrors: toolTotals?.tool_errors ?? 0,
        discoveryCalls: toolTotals?.discovery ?? 0,
        tokensBaseline: sessionTotals?.baseline ?? 0,
        tokensExposed: sessionTotals?.exposed ?? 0,
        tokensSaved: sessionTotals?.saved ?? 0,
        codeTokens: executionTotals?.code ?? 0,
        resultTokens: executionTotals?.result ?? 0,
        avgExecutionMs: executionTotals?.avg_ms == null ? null : Math.round(executionTotals.avg_ms),
        avgToolCallMs: toolTotals?.avg_ms == null ? null : Math.round(toolTotals.avg_ms),
      },
      catalog,
      agents: [...agents.values()].sort(
        (a, b) => b.executions - a.executions || b.lastSeen - a.lastSeen,
      ),
      integrations: integrations.map((row) => ({
        integration: row.integration,
        toolCalls: row.calls,
        errors: row.errors,
        avgDurationMs: Math.round(row.avg_ms),
        lastUsed: row.last_used,
      })),
      tools: tools.map((row) => ({
        path: row.path,
        integration: row.integration,
        calls: row.calls,
        errors: row.errors,
        avgDurationMs: Math.round(row.avg_ms),
        lastUsed: row.last_used,
      })),
      timeline: [...timeline.values()],
      errorCodes,
      recent: recent.map((row) => ({
        ts: row.ts,
        agent: row.agent ?? "unknown",
        path: row.path,
        kind: row.kind,
        ok: row.ok === 1,
        durationMs: row.duration_ms,
        errorCode: row.error_code,
      })),
    };
  };

  return {
    session,
    snapshot,
    close: async () => {
      const opened = client;
      client = null;
      if (opened) (await opened).close();
    },
  };
};

/** Outcome + ≈ tokens of the text an agent gets back for an engine result. */
const describeResult = (
  result: ExecutionResult,
): { readonly outcome: ExecutionOutcome; readonly resultTokens: number } =>
  result.status === "paused"
    ? {
        outcome: "paused",
        resultTokens: estimateTokens(formatPausedExecution(result.execution).text.length),
      }
    : {
        outcome: result.result.error ? "error" : "ok",
        resultTokens: estimateTokens(formatExecuteResult(result.result).text.length),
      };

/**
 * Record each execution an engine runs into `session`: inline `execute`,
 * pausable `executeWithPause`, and `resume` (which settles a paused one).
 * Mirrors `withExecutionAnalytics`; tool calls are recorded by the engine's
 * `onToolCall` seam.
 */
export const withExecutionStats = <E extends Cause.YieldableError>(
  engine: ExecutionEngine<E>,
  session: StatsSession,
): ExecutionEngine<E> => {
  const timed = <A, Err>(
    kind: "execute" | "resume",
    code: string,
    run: Effect.Effect<A, Err>,
    describe: (value: A) => { readonly outcome: ExecutionOutcome; readonly resultTokens: number },
  ): Effect.Effect<A, Err> =>
    Effect.suspend(() => {
      const startedAt = performance.now();
      const codeTokens = estimateTokens(code.length);
      const record = (outcome: ExecutionOutcome, resultTokens: number) =>
        Effect.sync(() =>
          session.recordExecution({
            kind,
            outcome,
            durationMs: Math.round(performance.now() - startedAt),
            codeTokens,
            resultTokens,
          }),
        );
      return run.pipe(
        Effect.tap((value) => {
          const { outcome, resultTokens } = describe(value);
          return record(outcome, resultTokens);
        }),
        Effect.tapError(() => record("error", 0)),
      );
    });
  return {
    ...engine,
    execute: (code, options) =>
      timed("execute", code, engine.execute(code, options), (result) =>
        describeResult({ status: "completed", result }),
      ),
    executeWithPause: (code, options) =>
      timed("execute", code, engine.executeWithPause(code, options), describeResult),
    resume: (executionId, response) =>
      timed("resume", "", engine.resume(executionId, response), (result) =>
        result ? describeResult(result) : { outcome: "error", resultTokens: 0 },
      ),
  };
};

// ---------------------------------------------------------------------------
// Daemon singleton + HTTP surface
// ---------------------------------------------------------------------------

let daemonStats: LocalStats | null = null;

/** The daemon's stats store, `<data dir>/stats.db`, opened on first use. */
export const getLocalStats = (): LocalStats => {
  daemonStats ??= makeLocalStats(join(resolveExecutorDataDir(), "stats.db"));
  return daemonStats;
};

export const disposeLocalStats = async (): Promise<void> => {
  const stats = daemonStats;
  daemonStats = null;
  if (stats) await stats.close();
};

const isStatsRange = (value: string): value is StatsRange =>
  value === "all" || Object.hasOwn(RANGE_MS, value);

/** `GET /api/stats?range=24h|7d|30d|all` (default `7d`). Bearer-gated by the shell. */
export const makeStatsRequestHandler =
  (stats: LocalStats, catalog: () => Promise<CatalogEstimate>) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const range = new URL(request.url).searchParams.get("range") ?? "7d";
    if (!isStatsRange(range)) return new Response("Unknown range", { status: 400 });
    const snapshot = await stats.snapshot(range, await catalog());
    return new Response(JSON.stringify(snapshot), {
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
