import type { ReactNode } from "react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { RefreshCwIcon } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackHeader,
} from "@executor-js/react/components/card-stack";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@executor-js/react/components/chart";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@executor-js/react/components/empty";
import { ErrorState } from "@executor-js/react/components/error-state";
import { FilterTabs, type FilterTab } from "@executor-js/react/components/filter-tabs";
import { HelpTooltip } from "@executor-js/react/components/help-tooltip";
import { PageContainer, PageHeader } from "@executor-js/react/components/page";
import { Skeleton } from "@executor-js/react/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@executor-js/react/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@executor-js/react/components/tabs";
import { isAsyncResultLoading } from "@executor-js/react/lib/async-result";
import { formatRelativeTime } from "@executor-js/react/lib/relative-time";
import { cn } from "@executor-js/react/lib/utils";

import type {
  StatsLoadError,
  StatsRange,
  StatsSnapshot,
  StatsView,
} from "../routes/app/statistics";

// ── Formatting ───────────────────────────────────────────────────────────

const formatCount = (value: number): string => value.toLocaleString();

/** Compact token counts: 950, 12.3k, 4.1M. */
const formatTokens = (value: number): string => {
  if (value < 1_000) return Math.round(value).toLocaleString();
  if (value < 1_000_000) return `${trimDecimal(value / 1_000)}k`;
  return `${trimDecimal(value / 1_000_000)}M`;
};

const trimDecimal = (value: number): string =>
  value >= 100 ? Math.round(value).toLocaleString() : String(Math.round(value * 10) / 10);

const formatDuration = (ms: number): string => {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
};

const formatPercent = (value: number): string =>
  `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;

const truncateLabel = (value: unknown): string => {
  const text = String(value);
  return text.length > 16 ? `${text.slice(0, 15)}…` : text;
};

/** Share of calls that did not error, in percent; null when nothing ran. */
const successRate = (calls: number, errors: number): number | null =>
  calls === 0 ? null : Math.round((Math.max(0, calls - errors) / calls) * 1_000) / 10;

/** Context Executor actually put in front of agents: its tool list, the code they sent, and results. */
const consumedTokens = (row: {
  readonly tokensExposed: number;
  readonly codeTokens: number;
  readonly resultTokens: number;
}): number => row.tokensExposed + row.codeTokens + row.resultTokens;

// ── Colours ──────────────────────────────────────────────────────────────

type ChartColor = { readonly light: string; readonly dark: string };

const COLORS = {
  blue: { light: "#2563eb", dark: "#60a5fa" },
  teal: { light: "#0d9488", dark: "#2dd4bf" },
  violet: { light: "#7c3aed", dark: "#a78bfa" },
  amber: { light: "#d97706", dark: "#fbbf24" },
  green: { light: "#16a34a", dark: "#4ade80" },
  gray: { light: "#a3a3a3", dark: "#737373" },
  destructive: { light: "var(--destructive)", dark: "var(--destructive)" },
} satisfies Record<string, ChartColor>;

/** Categorical palette for per-agent / per-integration slices; readable in both themes. */
const CATEGORY_COLORS: ReadonlyArray<ChartColor> = [
  COLORS.blue,
  COLORS.teal,
  COLORS.violet,
  COLORS.amber,
  { light: "#e11d48", dark: "#fb7185" },
  { light: "#0284c7", dark: "#38bdf8" },
  { light: "#65a30d", dark: "#a3e635" },
  { light: "#c026d3", dark: "#e879f9" },
];

const categoryColor = (index: number): ChartColor =>
  CATEGORY_COLORS[index % CATEGORY_COLORS.length] ?? COLORS.gray;

/**
 * Tooltip body that formats each value (tokens, %, ms) instead of the raw
 * number, and takes a categorical slice's colour from its row's `fill`.
 */
function formattedTooltip(
  config: ChartConfig,
  format: (value: number) => string,
  options: { readonly hideLabel?: boolean } = {},
) {
  const formatter = (
    value: unknown,
    name: unknown,
    item: { readonly color?: string; readonly payload?: unknown },
  ) => {
    const row = item.payload;
    const color =
      typeof row === "object" && row !== null && "fill" in row && typeof row.fill === "string"
        ? row.fill
        : (item.color ?? "currentColor");
    return (
      <div className="flex flex-1 items-center gap-2">
        <div className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />
        <span className="text-muted-foreground">{config[String(name)]?.label ?? String(name)}</span>
        <span className="ml-auto pl-3 font-mono font-medium text-foreground tabular-nums">
          {typeof value === "number" ? format(value) : "—"}
        </span>
      </div>
    );
  };
  return <ChartTooltipContent hideLabel={options.hideLabel === true} formatter={formatter} />;
}

// ── Page ─────────────────────────────────────────────────────────────────

const RANGE_TABS: FilterTab<StatsRange>[] = [
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "All", value: "all" },
];

export function StatisticsPage(props: {
  readonly stats: AsyncResult.AsyncResult<StatsSnapshot, StatsLoadError>;
  readonly range: StatsRange;
  readonly onRangeChange: (range: StatsRange) => void;
  readonly onRefresh: () => void;
  readonly view: StatsView;
  readonly onViewChange: (view: StatsView) => void;
}) {
  const { stats, range } = props;
  const snapshot = AsyncResult.isSuccess(stats) ? stats.value : null;
  const hasNoActivity =
    snapshot !== null && snapshot.totals.executions === 0 && snapshot.totals.toolCalls === 0;

  return (
    // Wider than the settings column: the dashboard grid and tables need the room.
    <PageContainer className="max-w-6xl">
      <PageHeader
        title="Statistics"
        description="Usage recorded locally by this Executor daemon. Nothing here leaves your machine."
      />

      <div className="mb-6 flex items-center justify-between gap-3">
        <FilterTabs tabs={RANGE_TABS} value={range} onChange={props.onRangeChange} />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={props.onRefresh}
          disabled={stats.waiting}
        >
          <RefreshCwIcon className={cn("size-3.5", stats.waiting && "animate-spin")} aria-hidden />
          Refresh
        </Button>
      </div>

      {hasNoActivity && (
        <Empty className="mb-6 border border-border/50">
          <EmptyHeader>
            <EmptyTitle>No activity in this range</EmptyTitle>
            <EmptyDescription>
              Statistics appear once an agent runs code through Executor's MCP endpoint. Connect an
              agent such as Claude Code or Codex, ask it to use a tool, and its executions and tool
              calls show up here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      <Tabs
        value={props.view}
        onValueChange={(value) => props.onViewChange(value === "data" ? "data" : "dashboard")}
        className="gap-6"
      >
        <TabsList variant="line">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>

        {isAsyncResultLoading(stats) ? (
          <StatisticsSkeleton />
        ) : (
          AsyncResult.match(stats, {
            onInitial: () => <StatisticsSkeleton />,
            onFailure: () => (
              <ErrorState message="Failed to load statistics" onRetry={props.onRefresh} />
            ),
            onSuccess: ({ value }) => (
              <>
                <TabsContent value="dashboard">
                  <StatisticsDashboard snapshot={value} />
                </TabsContent>
                <TabsContent value="data">
                  <StatisticsData snapshot={value} />
                </TabsContent>
              </>
            ),
          })
        )}
      </Tabs>
    </PageContainer>
  );
}

function StatisticsSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((card) => (
          <Skeleton key={card} className="h-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((chart) => (
          <Skeleton key={chart} className="h-[300px]" />
        ))}
      </div>
    </div>
  );
}

// ── Dashboard tab ────────────────────────────────────────────────────────

type TimelineRow = StatsSnapshot["timeline"][number] & {
  readonly label: string;
  readonly consumedTokens: number;
  readonly executionSuccess: number | null;
  readonly toolCallSuccess: number | null;
};

function StatisticsDashboard(props: { readonly snapshot: StatsSnapshot }) {
  const { snapshot } = props;
  const rows: TimelineRow[] = snapshot.timeline.map((point) => ({
    ...point,
    // Hourly buckets for 24h, daily otherwise.
    label:
      snapshot.range === "24h"
        ? new Date(point.bucket).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })
        : new Date(point.bucket).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          }),
    consumedTokens: consumedTokens(point),
    executionSuccess: successRate(point.executions, point.executionErrors),
    toolCallSuccess: successRate(point.toolCalls, point.toolCallErrors),
  }));
  return (
    <div className="flex flex-col gap-8">
      <SummaryCards snapshot={snapshot} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ContextTokensChart snapshot={snapshot} rows={rows} />
        <TokenBreakdownChart snapshot={snapshot} />
        <ExecutionOutcomesChart snapshot={snapshot} />
        <ActivityChart rows={rows} />
        <SuccessRateChart rows={rows} />
        <LatencyChart rows={rows} />
        <ExecutionsByAgentChart agents={snapshot.agents} />
        <ToolCallsByIntegrationChart integrations={snapshot.integrations} />
        <ErrorCodesChart errorCodes={snapshot.errorCodes} />
      </div>
    </div>
  );
}

function SummaryCards(props: { readonly snapshot: StatsSnapshot }) {
  const { totals, catalog } = props.snapshot;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard
        label="Executions"
        value={formatCount(totals.executions)}
        detail={
          <>
            <ErrorCount count={totals.executionErrors} />
            {totals.pausedForApproval > 0 && (
              <span> · {formatCount(totals.pausedForApproval)} paused</span>
            )}
          </>
        }
      />
      <StatCard
        label="Tool calls"
        value={formatCount(totals.toolCalls)}
        detail={
          <>
            <ErrorCount count={totals.toolCallErrors} />
            <span> · {formatCount(totals.discoveryCalls)} discovery</span>
          </>
        }
      />
      <StatCard
        label="Agent sessions"
        value={formatCount(totals.sessions)}
        detail="MCP sessions opened"
      />
      <StatCard
        label="Est. tokens saved"
        value={formatTokens(totals.tokensSaved)}
        help={<TokenMethodNote snapshot={props.snapshot} />}
        detail={`${formatTokens(totals.tokensBaseline)} without · ${formatTokens(consumedTokens(totals))} with Executor`}
      />
      <StatCard
        label="Catalog right now"
        value={`${formatCount(catalog.tools)} tools`}
        detail={`${formatCount(catalog.integrations)} integrations · ≈${formatTokens(catalog.tokens)} tokens if sent directly`}
      />
    </div>
  );
}

function TokenMethodNote(props: { readonly snapshot: StatsSnapshot }) {
  const { totals } = props.snapshot;
  return (
    <div className="flex flex-col gap-1.5">
      <p>
        Estimated as characters ÷ 4 of the JSON involved. Per agent session, the baseline is every
        catalog tool's name, description, and input schema the agent would load without Executor;
        exposed is the tools/list Executor actually sent. Saved = baseline − exposed.
      </p>
      <p>
        The baseline counts tool definitions only. Code agents send and results they get back are
        added to Executor's side, since results would cost the same either way.
      </p>
      <p className="tabular-nums">
        Baseline {formatTokens(totals.tokensBaseline)} · exposed{" "}
        {formatTokens(totals.tokensExposed)} · code {formatTokens(totals.codeTokens)} · results{" "}
        {formatTokens(totals.resultTokens)}
      </p>
    </div>
  );
}

function ErrorCount(props: { readonly count: number }) {
  return (
    <span className={cn(props.count > 0 && "text-destructive")}>
      {formatCount(props.count)} {props.count === 1 ? "error" : "errors"}
    </span>
  );
}

function StatCard(props: {
  readonly label: string;
  readonly value: string;
  readonly detail?: ReactNode;
  readonly help?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-card px-4 py-3">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">
        <span>{props.label}</span>
        {props.help && <HelpTooltip label={props.label}>{props.help}</HelpTooltip>}
      </div>
      <div className="text-2xl font-medium tabular-nums text-foreground">{props.value}</div>
      {props.detail && (
        <div className="text-xs leading-snug text-muted-foreground tabular-nums">
          {props.detail}
        </div>
      )}
    </div>
  );
}

function ChartCard(props: {
  readonly title: string;
  readonly description: string;
  readonly empty: boolean;
  readonly emptyMessage?: string;
  readonly help?: ReactNode;
  readonly headline?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border border-border/50 bg-card p-4",
        props.className,
      )}
    >
      <div>
        <h2 className="flex items-center gap-1 text-sm font-medium text-foreground">
          {props.title}
          {props.help && <HelpTooltip label={props.title}>{props.help}</HelpTooltip>}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
      </div>
      {props.empty ? (
        <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed border-border/60 px-4 text-center text-xs text-muted-foreground">
          {props.emptyMessage ?? "Nothing recorded in this range."}
        </div>
      ) : (
        <>
          {props.headline}
          {props.children}
        </>
      )}
    </section>
  );
}

const chartClassName = "aspect-auto h-[220px] w-full";

const contextTokensConfig = {
  tokensBaseline: { label: "Without Executor", theme: COLORS.gray },
  consumedTokens: { label: "With Executor (consumed)", theme: COLORS.blue },
} satisfies ChartConfig;

function ContextTokensChart(props: {
  readonly snapshot: StatsSnapshot;
  readonly rows: ReadonlyArray<TimelineRow>;
}) {
  const { totals } = props.snapshot;
  const empty = props.rows.every((row) => row.tokensBaseline === 0 && row.consumedTokens === 0);
  return (
    <ChartCard
      className="lg:col-span-2"
      title="Context tokens over time"
      description="Tool definitions agents would have loaded without Executor vs. the context Executor actually used."
      help={<TokenMethodNote snapshot={props.snapshot} />}
      empty={empty}
      headline={
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 tabular-nums">
          <div>
            <span className="text-2xl font-medium text-foreground">
              {formatTokens(totals.tokensSaved)}
            </span>
            <span className="ml-1.5 text-xs text-muted-foreground">saved</span>
          </div>
          <div>
            <span className="text-2xl font-medium text-foreground">
              {formatTokens(consumedTokens(totals))}
            </span>
            <span className="ml-1.5 text-xs text-muted-foreground">consumed with Executor</span>
          </div>
        </div>
      }
    >
      <ChartContainer config={contextTokensConfig} className={chartClassName}>
        <AreaChart data={[...props.rows]} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={formatTokens} />
          <ChartTooltip content={formattedTooltip(contextTokensConfig, formatTokens)} />
          <ChartLegend content={<ChartLegendContent />} />
          <Area
            type="monotone"
            dataKey="tokensBaseline"
            stroke="var(--color-tokensBaseline)"
            fill="var(--color-tokensBaseline)"
            fillOpacity={0.15}
          />
          <Area
            type="monotone"
            dataKey="consumedTokens"
            stroke="var(--color-consumedTokens)"
            fill="var(--color-consumedTokens)"
            fillOpacity={0.3}
          />
        </AreaChart>
      </ChartContainer>
    </ChartCard>
  );
}

type DonutSlice = {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly color: ChartColor;
};

/** Donut plus a value/percentage legend; slice keys must be CSS identifiers. */
function DonutChart(props: {
  readonly slices: ReadonlyArray<DonutSlice>;
  readonly format: (value: number) => string;
}) {
  const config: ChartConfig = Object.fromEntries(
    props.slices.map((slice) => [slice.key, { label: slice.label, theme: slice.color }]),
  );
  const total = props.slices.reduce((sum, slice) => sum + slice.value, 0);
  const data = props.slices
    .filter((slice) => slice.value > 0)
    .map((slice) => ({ key: slice.key, value: slice.value, fill: `var(--color-${slice.key})` }));
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <ChartContainer config={config} className="aspect-square h-[200px] shrink-0">
        <PieChart>
          <ChartTooltip content={formattedTooltip(config, props.format, { hideLabel: true })} />
          <Pie data={data} dataKey="value" nameKey="key" innerRadius={52} outerRadius={84}>
            {data.map((slice) => (
              <Cell key={slice.key} fill={slice.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="flex w-full min-w-0 flex-col gap-1.5 text-xs">
        {props.slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2">
            <div
              className="size-2.5 shrink-0 rounded-[2px] bg-(--swatch-light) dark:bg-(--swatch-dark)"
              style={
                {
                  "--swatch-light": slice.color.light,
                  "--swatch-dark": slice.color.dark,
                } as React.CSSProperties
              }
            />
            <span className="min-w-0 truncate text-muted-foreground">{slice.label}</span>
            <span className="ml-auto font-mono text-foreground tabular-nums">
              {props.format(slice.value)}
            </span>
            <span className="w-12 text-right text-muted-foreground tabular-nums">
              {total > 0 ? formatPercent((slice.value / total) * 100) : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TokenBreakdownChart(props: { readonly snapshot: StatsSnapshot }) {
  const { totals } = props.snapshot;
  const slices: DonutSlice[] = [
    { key: "saved", label: "Saved", value: totals.tokensSaved, color: COLORS.green },
    { key: "exposed", label: "Tool list sent", value: totals.tokensExposed, color: COLORS.blue },
    { key: "code", label: "Code sent", value: totals.codeTokens, color: COLORS.violet },
    { key: "results", label: "Results returned", value: totals.resultTokens, color: COLORS.amber },
  ];
  return (
    <ChartCard
      title="Tokens saved vs. consumed"
      description="Where the estimated context went across all sessions in this range."
      help={<TokenMethodNote snapshot={props.snapshot} />}
      empty={slices.every((slice) => slice.value === 0)}
    >
      <DonutChart slices={slices} format={formatTokens} />
    </ChartCard>
  );
}

function ExecutionOutcomesChart(props: { readonly snapshot: StatsSnapshot }) {
  const { totals } = props.snapshot;
  const slices: DonutSlice[] = [
    {
      key: "ok",
      label: "Completed",
      value: Math.max(0, totals.executions - totals.executionErrors - totals.pausedForApproval),
      color: COLORS.teal,
    },
    { key: "errors", label: "Errored", value: totals.executionErrors, color: COLORS.destructive },
    {
      key: "paused",
      label: "Paused for approval",
      value: totals.pausedForApproval,
      color: COLORS.amber,
    },
  ];
  return (
    <ChartCard
      title="Execution outcomes"
      description="How code executions ended: completed, errored, or paused for approval."
      empty={totals.executions === 0}
      emptyMessage="No executions in this range."
    >
      <DonutChart slices={slices} format={formatCount} />
    </ChartCard>
  );
}

const activityConfig = {
  executions: { label: "Executions", theme: COLORS.blue },
  toolCalls: { label: "Tool calls", theme: COLORS.teal },
  discoveryCalls: { label: "Discovery calls", theme: COLORS.violet },
} satisfies ChartConfig;

function ActivityChart(props: { readonly rows: ReadonlyArray<TimelineRow> }) {
  const empty = props.rows.every(
    (row) => row.executions === 0 && row.toolCalls === 0 && row.discoveryCalls === 0,
  );
  return (
    <ChartCard
      title="Activity"
      description="Executions, integration tool calls, and discovery calls per bucket."
      empty={empty}
    >
      <ChartContainer config={activityConfig} className={chartClassName}>
        <BarChart data={[...props.rows]} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <ChartTooltip content={formattedTooltip(activityConfig, formatCount)} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="executions"
            stackId="activity"
            fill="var(--color-executions)"
            maxBarSize={32}
          />
          <Bar
            dataKey="toolCalls"
            stackId="activity"
            fill="var(--color-toolCalls)"
            maxBarSize={32}
          />
          <Bar
            dataKey="discoveryCalls"
            stackId="activity"
            fill="var(--color-discoveryCalls)"
            maxBarSize={32}
          />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

const successRateConfig = {
  executionSuccess: { label: "Executions", theme: COLORS.blue },
  toolCallSuccess: { label: "Tool calls", theme: COLORS.teal },
} satisfies ChartConfig;

function SuccessRateChart(props: { readonly rows: ReadonlyArray<TimelineRow> }) {
  const empty = props.rows.every(
    (row) => row.executionSuccess === null && row.toolCallSuccess === null,
  );
  return (
    <ChartCard
      title="Success rate"
      description="Share of executions and tool calls without an error; empty buckets are skipped."
      empty={empty}
    >
      <ChartContainer config={successRateConfig} className={chartClassName}>
        <LineChart data={[...props.rows]} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value: number) => `${value}%`}
          />
          <ChartTooltip content={formattedTooltip(successRateConfig, formatPercent)} />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            type="monotone"
            dataKey="executionSuccess"
            stroke="var(--color-executionSuccess)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="toolCallSuccess"
            stroke="var(--color-toolCallSuccess)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

const latencyConfig = {
  avgExecutionMs: { label: "Execution", theme: COLORS.blue },
  avgToolCallMs: { label: "Tool call", theme: COLORS.teal },
} satisfies ChartConfig;

function LatencyChart(props: { readonly rows: ReadonlyArray<TimelineRow> }) {
  const empty = props.rows.every(
    (row) => row.avgExecutionMs === null && row.avgToolCallMs === null,
  );
  return (
    <ChartCard
      title="Latency"
      description="Average execution and tool-call duration per bucket."
      empty={empty}
    >
      <ChartContainer config={latencyConfig} className={chartClassName}>
        <LineChart data={[...props.rows]} margin={{ left: 0, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={formatDuration}
          />
          <ChartTooltip content={formattedTooltip(latencyConfig, formatDuration)} />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            type="monotone"
            dataKey="avgExecutionMs"
            stroke="var(--color-avgExecutionMs)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="avgToolCallMs"
            stroke="var(--color-avgToolCallMs)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
        </LineChart>
      </ChartContainer>
    </ChartCard>
  );
}

const AGENT_SLICE_LIMIT = 6;

function ExecutionsByAgentChart(props: { readonly agents: StatsSnapshot["agents"] }) {
  const active = props.agents.filter((agent) => agent.executions > 0);
  const top = active.slice(0, AGENT_SLICE_LIMIT);
  const otherExecutions = active
    .slice(AGENT_SLICE_LIMIT)
    .reduce((sum, agent) => sum + agent.executions, 0);
  const slices: DonutSlice[] = top.map((agent, index) => ({
    key: `agent${index}`,
    label: agent.plane === "api" ? agent.agent : `${agent.agent} (${agent.plane})`,
    value: agent.executions,
    color: categoryColor(index),
  }));
  if (otherExecutions > 0) {
    slices.push({ key: "other", label: "Other", value: otherExecutions, color: COLORS.gray });
  }
  return (
    <ChartCard
      title="Executions by agent"
      description="Which MCP clients and API callers ran code through Executor."
      empty={slices.length === 0}
      emptyMessage="No executions in this range."
    >
      <DonutChart slices={slices} format={formatCount} />
    </ChartCard>
  );
}

/** Horizontal bars, one colour per row; `label` is the category axis. */
function HorizontalBarChart(props: {
  readonly rows: ReadonlyArray<{ readonly label: string; readonly value: number }>;
  readonly valueLabel: string;
  readonly colorFor: (index: number) => ChartColor;
}) {
  const config: ChartConfig = {
    value: { label: props.valueLabel },
    ...Object.fromEntries(
      props.rows.map((_, index) => [`row${index}`, { label: "", theme: props.colorFor(index) }]),
    ),
  };
  const data = props.rows.map((row, index) => ({
    label: row.label,
    value: row.value,
    fill: `var(--color-row${index})`,
  }));
  return (
    <ChartContainer config={config} className={chartClassName}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          width={120}
          tickFormatter={truncateLabel}
        />
        <ChartTooltip cursor={false} content={formattedTooltip(config, formatCount)} />
        <Bar dataKey="value" radius={3} maxBarSize={28}>
          {data.map((row) => (
            <Cell key={row.label} fill={row.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

const INTEGRATION_BAR_LIMIT = 8;

function ToolCallsByIntegrationChart(props: {
  readonly integrations: StatsSnapshot["integrations"];
}) {
  const rows = props.integrations
    .filter((row) => row.toolCalls > 0)
    .slice(0, INTEGRATION_BAR_LIMIT)
    .map((row) => ({ label: row.integration, value: row.toolCalls }));
  return (
    <ChartCard
      title="Tool calls by integration"
      description={`The ${INTEGRATION_BAR_LIMIT} most-called integrations from sandbox code.`}
      empty={rows.length === 0}
      emptyMessage="No integration tools called in this range."
    >
      <HorizontalBarChart rows={rows} valueLabel="Tool calls" colorFor={categoryColor} />
    </ChartCard>
  );
}

function ErrorCodesChart(props: { readonly errorCodes: StatsSnapshot["errorCodes"] }) {
  const rows = props.errorCodes
    .filter((row) => row.count > 0)
    .map((row) => ({ label: row.code, value: row.count }));
  return (
    <ChartCard
      title="Error codes"
      description="The most frequent tool-call error codes."
      empty={rows.length === 0}
      emptyMessage="No tool-call errors in this range."
    >
      <HorizontalBarChart rows={rows} valueLabel="Errors" colorFor={() => COLORS.destructive} />
    </ChartCard>
  );
}

// ── Data tab ─────────────────────────────────────────────────────────────

function StatisticsData(props: { readonly snapshot: StatsSnapshot }) {
  const { snapshot } = props;
  return (
    <div className="flex flex-col gap-8">
      <AgentsTable agents={snapshot.agents} />
      <IntegrationsTable integrations={snapshot.integrations} />
      <ToolsTable tools={snapshot.tools} />
      <ErrorCodesTable
        errorCodes={snapshot.errorCodes}
        toolCallErrors={snapshot.totals.toolCallErrors}
      />
      <RecentCallsTable recent={snapshot.recent} />
    </div>
  );
}

const edgeCell = "first:pl-4 last:pr-4";
const numericCell = cn(edgeCell, "text-right tabular-nums");

function StatsTable(props: {
  readonly title: string;
  readonly headers: ReadonlyArray<{ readonly label: string; readonly numeric?: boolean }>;
  readonly emptyMessage: string;
  readonly rowCount: number;
  readonly children: ReactNode;
}) {
  return (
    <CardStack>
      <CardStackHeader>{props.title}</CardStackHeader>
      <CardStackContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {props.headers.map((header) => (
                <TableHead
                  key={header.label}
                  className={cn(
                    header.numeric ? numericCell : edgeCell,
                    "text-xs font-normal text-muted-foreground",
                  )}
                >
                  {header.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.rowCount === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell
                  colSpan={props.headers.length}
                  className={cn(edgeCell, "py-6 text-center text-muted-foreground")}
                >
                  {props.emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              props.children
            )}
          </TableBody>
        </Table>
      </CardStackContent>
    </CardStack>
  );
}

function ErrorsCell(props: { readonly count: number }) {
  return (
    <TableCell className={cn(numericCell, props.count > 0 && "text-destructive")}>
      {formatCount(props.count)}
    </TableCell>
  );
}

function AgentsTable(props: { readonly agents: StatsSnapshot["agents"] }) {
  return (
    <StatsTable
      title="Agents"
      emptyMessage="No agents connected in this range."
      rowCount={props.agents.length}
      headers={[
        { label: "Agent" },
        { label: "Plane" },
        { label: "Sessions", numeric: true },
        { label: "Executions", numeric: true },
        { label: "Errors", numeric: true },
        { label: "Tool calls", numeric: true },
        { label: "Code tokens", numeric: true },
        { label: "Result tokens", numeric: true },
        { label: "Tokens saved", numeric: true },
        { label: "Last seen", numeric: true },
      ]}
    >
      {props.agents.map((agent) => (
        <TableRow key={`${agent.plane}:${agent.agent}`}>
          <TableCell className={edgeCell}>
            <span className="font-medium text-foreground">{agent.agent}</span>
            {agent.version && (
              <span className="ml-1.5 font-mono text-xs text-muted-foreground">
                {agent.version}
              </span>
            )}
          </TableCell>
          <TableCell className={edgeCell}>
            <Badge variant="outline" className="font-mono uppercase">
              {agent.plane}
            </Badge>
          </TableCell>
          <TableCell className={numericCell}>{formatCount(agent.sessions)}</TableCell>
          <TableCell className={numericCell}>{formatCount(agent.executions)}</TableCell>
          <ErrorsCell count={agent.executionErrors} />
          <TableCell className={numericCell}>{formatCount(agent.toolCalls)}</TableCell>
          <TableCell className={numericCell}>{formatTokens(agent.codeTokens)}</TableCell>
          <TableCell className={numericCell}>{formatTokens(agent.resultTokens)}</TableCell>
          <TableCell className={numericCell}>{formatTokens(agent.tokensSaved)}</TableCell>
          <TableCell className={cn(numericCell, "text-muted-foreground")}>
            {formatRelativeTime(agent.lastSeen)}
          </TableCell>
        </TableRow>
      ))}
    </StatsTable>
  );
}

function IntegrationsTable(props: { readonly integrations: StatsSnapshot["integrations"] }) {
  return (
    <StatsTable
      title="Integrations"
      emptyMessage="No integration tools called in this range."
      rowCount={props.integrations.length}
      headers={[
        { label: "Integration" },
        { label: "Tool calls", numeric: true },
        { label: "Errors", numeric: true },
        { label: "Avg duration", numeric: true },
        { label: "Last used", numeric: true },
      ]}
    >
      {props.integrations.map((row) => (
        <TableRow key={row.integration}>
          <TableCell className={cn(edgeCell, "font-medium text-foreground")}>
            {row.integration}
          </TableCell>
          <TableCell className={numericCell}>{formatCount(row.toolCalls)}</TableCell>
          <ErrorsCell count={row.errors} />
          <TableCell className={numericCell}>{formatDuration(row.avgDurationMs)}</TableCell>
          <TableCell className={cn(numericCell, "text-muted-foreground")}>
            {formatRelativeTime(row.lastUsed)}
          </TableCell>
        </TableRow>
      ))}
    </StatsTable>
  );
}

function ToolsTable(props: { readonly tools: StatsSnapshot["tools"] }) {
  return (
    <StatsTable
      title="Top tools"
      emptyMessage="No tools called in this range."
      rowCount={props.tools.length}
      headers={[
        { label: "Tool" },
        { label: "Calls", numeric: true },
        { label: "Errors", numeric: true },
        { label: "Avg duration", numeric: true },
        { label: "Last used", numeric: true },
      ]}
    >
      {props.tools.map((row) => (
        <TableRow key={row.path}>
          <TableCell className={cn(edgeCell, "font-mono text-xs text-foreground")}>
            {row.path}
          </TableCell>
          <TableCell className={numericCell}>{formatCount(row.calls)}</TableCell>
          <ErrorsCell count={row.errors} />
          <TableCell className={numericCell}>{formatDuration(row.avgDurationMs)}</TableCell>
          <TableCell className={cn(numericCell, "text-muted-foreground")}>
            {formatRelativeTime(row.lastUsed)}
          </TableCell>
        </TableRow>
      ))}
    </StatsTable>
  );
}

function ErrorCodesTable(props: {
  readonly errorCodes: StatsSnapshot["errorCodes"];
  readonly toolCallErrors: number;
}) {
  return (
    <StatsTable
      title="Error codes"
      emptyMessage="No tool-call errors in this range."
      rowCount={props.errorCodes.length}
      headers={[
        { label: "Code" },
        { label: "Count", numeric: true },
        { label: "Share of tool-call errors", numeric: true },
      ]}
    >
      {props.errorCodes.map((row) => (
        <TableRow key={row.code}>
          <TableCell className={cn(edgeCell, "font-mono text-xs text-foreground")}>
            {row.code}
          </TableCell>
          <TableCell className={cn(numericCell, "text-destructive")}>
            {formatCount(row.count)}
          </TableCell>
          <TableCell className={cn(numericCell, "text-muted-foreground")}>
            {props.toolCallErrors > 0
              ? formatPercent((row.count / props.toolCallErrors) * 100)
              : "—"}
          </TableCell>
        </TableRow>
      ))}
    </StatsTable>
  );
}

function RecentCallsTable(props: { readonly recent: StatsSnapshot["recent"] }) {
  return (
    <StatsTable
      title="Recent calls"
      emptyMessage="No calls recorded in this range."
      rowCount={props.recent.length}
      headers={[
        { label: "Time" },
        { label: "Agent" },
        { label: "Tool" },
        { label: "Kind" },
        { label: "Status" },
        { label: "Duration", numeric: true },
      ]}
    >
      {props.recent.map((call, index) => (
        <TableRow key={`${call.ts}:${call.path}:${index}`}>
          <TableCell className={cn(edgeCell, "text-muted-foreground tabular-nums")}>
            {new Date(call.ts).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
          </TableCell>
          <TableCell className={edgeCell}>{call.agent}</TableCell>
          <TableCell className={cn(edgeCell, "font-mono text-xs text-foreground")}>
            {call.path}
          </TableCell>
          <TableCell className={edgeCell}>
            <Badge variant={call.kind === "tool" ? "secondary" : "outline"}>{call.kind}</Badge>
          </TableCell>
          <TableCell className={edgeCell}>
            {call.ok ? (
              <Badge variant="outline">ok</Badge>
            ) : (
              <Badge variant="destructive">
                error{call.errorCode ? ` · ${call.errorCode}` : ""}
              </Badge>
            )}
          </TableCell>
          <TableCell className={numericCell}>{formatDuration(call.durationMs)}</TableCell>
        </TableRow>
      ))}
    </StatsTable>
  );
}
