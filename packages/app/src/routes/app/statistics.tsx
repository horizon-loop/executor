import { useState } from "react";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Data, Effect, Option, Schema } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import { createFileRoute } from "@tanstack/react-router";
import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthorizationHeader,
} from "@executor-js/react/api/server-connection";
import { useExecutorDocumentTitle } from "@executor-js/react/lib/document-title";

import { StatisticsPage } from "../../web/statistics-page";

// Mirrors the local daemon's `GET /api/stats` body (`StatsSnapshot`). Local and
// desktop only: the daemon records usage on this machine and nothing leaves it.
const StatsRangeSchema = Schema.Literals(["24h", "7d", "30d", "all"]);
const StatsViewSchema = Schema.Literals(["dashboard", "data"]);

// `view` keeps the selected tab linkable and stable across reloads.
const SearchParams = Schema.toStandardSchemaV1(
  Schema.Struct({
    view: Schema.optional(StatsViewSchema),
  }),
);

const StatsSnapshotSchema = Schema.Struct({
  range: StatsRangeSchema,
  since: Schema.NullOr(Schema.Number),
  generatedAt: Schema.Number,
  totals: Schema.Struct({
    sessions: Schema.Number,
    executions: Schema.Number,
    executionErrors: Schema.Number,
    pausedForApproval: Schema.Number,
    toolCalls: Schema.Number,
    toolCallErrors: Schema.Number,
    discoveryCalls: Schema.Number,
    tokensBaseline: Schema.Number,
    tokensExposed: Schema.Number,
    tokensSaved: Schema.Number,
    codeTokens: Schema.Number,
    resultTokens: Schema.Number,
    avgExecutionMs: Schema.NullOr(Schema.Number),
    avgToolCallMs: Schema.NullOr(Schema.Number),
  }),
  catalog: Schema.Struct({
    tools: Schema.Number,
    integrations: Schema.Number,
    tokens: Schema.Number,
  }),
  agents: Schema.Array(
    Schema.Struct({
      agent: Schema.String,
      version: Schema.NullOr(Schema.String),
      plane: Schema.Literals(["mcp", "api"]),
      sessions: Schema.Number,
      executions: Schema.Number,
      executionErrors: Schema.Number,
      toolCalls: Schema.Number,
      tokensSaved: Schema.Number,
      codeTokens: Schema.Number,
      resultTokens: Schema.Number,
      lastSeen: Schema.Number,
    }),
  ),
  integrations: Schema.Array(
    Schema.Struct({
      integration: Schema.String,
      toolCalls: Schema.Number,
      errors: Schema.Number,
      avgDurationMs: Schema.Number,
      lastUsed: Schema.Number,
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      integration: Schema.String,
      calls: Schema.Number,
      errors: Schema.Number,
      avgDurationMs: Schema.Number,
      lastUsed: Schema.Number,
    }),
  ),
  timeline: Schema.Array(
    Schema.Struct({
      bucket: Schema.Number,
      executions: Schema.Number,
      executionErrors: Schema.Number,
      pausedForApproval: Schema.Number,
      toolCalls: Schema.Number,
      toolCallErrors: Schema.Number,
      discoveryCalls: Schema.Number,
      errors: Schema.Number,
      tokensBaseline: Schema.Number,
      tokensExposed: Schema.Number,
      tokensSaved: Schema.Number,
      codeTokens: Schema.Number,
      resultTokens: Schema.Number,
      avgExecutionMs: Schema.NullOr(Schema.Number),
      avgToolCallMs: Schema.NullOr(Schema.Number),
    }),
  ),
  recent: Schema.Array(
    Schema.Struct({
      ts: Schema.Number,
      agent: Schema.String,
      path: Schema.String,
      kind: Schema.Literals(["tool", "discovery"]),
      ok: Schema.Boolean,
      durationMs: Schema.Number,
      errorCode: Schema.NullOr(Schema.String),
    }),
  ),
  errorCodes: Schema.Array(
    Schema.Struct({
      code: Schema.String,
      count: Schema.Number,
    }),
  ),
});
const decodeStatsSnapshot = Schema.decodeUnknownOption(StatsSnapshotSchema);

// Only `Route` is a runtime export: the router code-splits this file, and the
// page imports the rest as types.
export type StatsRange = typeof StatsRangeSchema.Type;
export type StatsView = typeof StatsViewSchema.Type;
export type StatsSnapshot = typeof StatsSnapshotSchema.Type;

class StatsLoadError extends Data.TaggedError("StatsLoadError")<{
  readonly message: string;
}> {}
export type { StatsLoadError };

const statsAtom = Atom.family((range: StatsRange) =>
  Atom.make(
    Effect.gen(function* () {
      // `/api/stats` is bearer-gated like the rest of /api, and served by the
      // ACTIVE server (the switcher can point at another daemon than the one
      // that served this page). Standalone web carries the bearer; on desktop
      // the main process injects it, so this is null and we send none.
      const authorization = getExecutorServerAuthorizationHeader();
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(
            `${getExecutorApiBaseUrl()}/stats?range=${encodeURIComponent(range)}`,
            authorization ? { headers: { authorization } } : undefined,
          ),
        catch: () => new StatsLoadError({ message: "Failed to load statistics." }),
      });
      if (!response.ok) {
        return yield* new StatsLoadError({
          message: `Statistics unavailable (${response.status}).`,
        });
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => new StatsLoadError({ message: "Statistics response was not valid JSON." }),
      });
      const decoded = decodeStatsSnapshot(body);
      if (Option.isNone(decoded)) {
        return yield* new StatsLoadError({
          message: "Statistics response had an unexpected shape.",
        });
      }
      return decoded.value;
    }),
  ),
);

export const Route = createFileRoute("/{-$orgSlug}/statistics")({
  validateSearch: SearchParams,
  component: StatisticsRoute,
});

function StatisticsRoute() {
  useExecutorDocumentTitle("Statistics");
  const { view = "dashboard" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [range, setRange] = useState<StatsRange>("7d");
  const stats = useAtomValue(statsAtom(range));
  const refresh = useAtomRefresh(statsAtom(range));
  return (
    <StatisticsPage
      stats={stats}
      range={range}
      onRangeChange={setRange}
      onRefresh={refresh}
      view={view}
      onViewChange={(next) => void navigate({ search: { view: next }, replace: true })}
    />
  );
}
