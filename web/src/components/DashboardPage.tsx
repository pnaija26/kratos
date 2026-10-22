import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { LuActivity, LuRefreshCw, LuTable2, LuChartColumn } from "react-icons/lu";
import { api, type Analytics, type AnalyticsRange, type GenerationPoint } from "../api";

/**
 * How much the model has done and how fast.
 *
 * Generation speed is the headline: it is what decides whether leaving the
 * agent on a task is a coffee break or an afternoon. Exact for llama.cpp —
 * its own timings, read off the stream by the portal's proxy — and wall clock
 * for anything else, which is close for long answers and generous for short
 * ones, so messages under a handful of tokens are left out of the averages.
 */

const RANGES: { id: AnalyticsRange; label: string }[] = [
  { id: "1", label: "24h" },
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
  { id: "all", label: "All" },
];

const fmtInt = (n: number) => n.toLocaleString();
const fmtTps = (n: number | null | undefined) => (n == null ? "—" : n >= 100 ? Math.round(n).toString() : n.toFixed(1));
const fmtCompact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const fmtCost = (n: number) => (n === 0 ? "$0" : n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);

export function DashboardPage({ onOpenJob }: { onOpenJob: (id: string) => void }) {
  const [range, setRange] = useState<AnalyticsRange>(() => {
    try {
      return (localStorage.getItem("dashboardRange") as AnalyticsRange) || "7";
    } catch {
      return "7";
    }
  });
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.analytics(range));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
    // New generations land while you watch; a quarter minute is plenty.
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const pick = (r: AnalyticsRange) => {
    setRange(r);
    try {
      localStorage.setItem("dashboardRange", r);
    } catch {
      // Private window: the choice just is not remembered.
    }
  };

  const t = data?.totals;

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          <header className="flex flex-wrap items-center gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
              <LuActivity className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-fg">Dashboard</h2>
              <p className="text-sm text-fg-muted">Model throughput and what the agent has produced.</p>
            </div>
            <div role="group" aria-label="Time range" className="flex flex-wrap rounded-lg border border-line bg-raised/40 p-0.5">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  onClick={() => pick(r.id)}
                  aria-pressed={range === r.id}
                  className={`rounded-md px-2.5 py-1 text-xs transition ${
                    range === r.id ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void load()}
              title="Refresh"
              aria-label="Refresh"
              className="rounded-lg border border-line p-1.5 text-fg-muted hover:bg-fg/5 hover:text-fg"
            >
              <LuRefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          </header>

          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

          {!data ? (
            <p className="py-16 text-center text-sm text-fg-subtle">Loading…</p>
          ) : (
            <>
              <section className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)]">
                <div className="rounded-2xl border border-line bg-gradient-to-br from-accent/10 via-transparent to-transparent p-5">
                  <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Generation speed</p>
                  <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-5xl font-semibold tabular-nums tracking-tight text-fg">{fmtTps(t!.avgTps)}</span>
                    <span className="text-sm text-fg-muted">tok/s average</span>
                  </p>
                  <dl className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2 text-sm">
                    <Mini label="median" value={fmtTps(t!.medianTps)} />
                    <Mini label="p10 – p90" value={t!.p10Tps == null ? "—" : `${fmtTps(t!.p10Tps)}–${fmtTps(t!.p90Tps)}`} />
                    <Mini label="peak" value={fmtTps(t!.peakTps)} />
                  </dl>
                  {t!.estimated > 0 && (
                    <p className="mt-3 text-[11px] leading-snug text-fg-faint">
                      {fmtInt(t!.estimated)} older message{t!.estimated === 1 ? " was" : "s were"} timed end to end, prompt
                      processing included, so {t!.estimated === 1 ? "it reads" : "they read"} slower than the live measurements.
                    </p>
                  )}
                  {data.latest && (
                    <p className="mt-4 truncate text-xs text-fg-subtle">
                      Latest: <span className="tabular-nums text-fg-muted">{fmtTps(data.latest.tps)} tok/s</span> ·{" "}
                      {data.latest.model || "unknown model"} · {timeAgo(data.latest.at)}
                      {data.latest.exact ? " · measured by llama.cpp" : ""}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
                  <Tile label="Prompt processing" value={fmtTps(t!.avgPrefillTps)} unit="tok/s" hint="llama.cpp only" />
                  <Tile label="Time to first token" value={fmtMs(t!.avgTtftMs)} hint="average" />
                  <Tile label="Output tokens" value={fmtCompact(t!.outputTokens)} hint={`${fmtInt(t!.generations)} messages`} />
                  <Tile label="Input tokens" value={fmtCompact(t!.inputTokens)} hint={t!.cacheRead ? `${fmtCompact(t!.cacheRead)} from cache` : undefined} />
                  <Tile label="Active sessions" value={fmtInt(t!.sessions)} hint={`${fmtInt(data.jobs.total)} jobs in total`} />
                  <Tile
                    label="Jobs now"
                    value={fmtInt(data.jobs.byStatus.running ?? 0)}
                    unit="running"
                    hint={
                      (data.jobs.byStatus.error ?? 0) + (data.jobs.byStatus.interrupted ?? 0)
                        ? `${data.jobs.byStatus.error ?? 0} failed · ${data.jobs.byStatus.interrupted ?? 0} interrupted`
                        : t!.cost > 0
                          ? `${fmtCost(t!.cost)} spent`
                          : "none failed"
                    }
                  />
                </div>
              </section>

              {t!.generations === 0 ? (
                <div className="rounded-2xl border border-line bg-raised/30 px-6 py-12 text-center">
                  <p className="text-sm text-fg-muted">Nothing generated in this range yet.</p>
                  <p className="mt-1 text-xs text-fg-subtle">
                    Every reply the model writes from here on is measured and shows up here.
                  </p>
                </div>
              ) : (
                <>
                  <ChartCard
                    title="Speed per message"
                    subtitle={`Generation tok/s for the last ${data.points.filter((p) => p.tps != null).length} measured messages`}
                    table={<PointsTable points={data.points} />}
                  >
                    <SpeedScatter points={data.points} avg={t!.avgTps} />
                  </ChartCard>

                  <ChartCard
                    title="Output tokens per day"
                    subtitle="What the model wrote, including reasoning and tool calls"
                    table={<DaysTable series={data.series} />}
                  >
                    <DailyBars series={data.series} />
                  </ChartCard>

                  <section className="rounded-2xl border border-line bg-surface">
                    <h3 className="border-b border-line px-4 py-3 text-sm font-medium text-fg">By model</h3>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-left text-[11px] uppercase tracking-wider text-fg-subtle">
                          <tr>
                            <Th>Model</Th>
                            <Th right>Messages</Th>
                            <Th right>Output</Th>
                            <Th right>Avg tok/s</Th>
                            <Th right>Median</Th>
                            <Th right>Prefill tok/s</Th>
                            <Th right>First token</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.models.map((m) => (
                            <tr key={`${m.provider}/${m.model}`} className="border-t border-line">
                              <td className="max-w-[16rem] px-4 py-2">
                                <p className="truncate text-fg">{m.model || "unknown"}</p>
                                <p className="truncate text-[11px] text-fg-faint">{m.provider}</p>
                              </td>
                              <Td>{fmtInt(m.generations)}</Td>
                              <Td>{fmtCompact(m.outputTokens)}</Td>
                              <Td strong>{fmtTps(m.avgTps)}</Td>
                              <Td>{fmtTps(m.medianTps)}</Td>
                              <Td>{fmtTps(m.avgPrefillTps)}</Td>
                              <Td>{fmtMs(m.avgTtftMs)}</Td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="rounded-2xl border border-line bg-surface">
                    <h3 className="border-b border-line px-4 py-3 text-sm font-medium text-fg">Busiest jobs</h3>
                    <ul>
                      {data.sessions.map((s) => (
                        <li key={s.id} className="border-t border-line first:border-t-0">
                          <button
                            onClick={() => onOpenJob(s.id)}
                            className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-fg/5"
                          >
                            <span className="min-w-0 flex-1 truncate text-fg">{s.title ?? <em className="text-fg-subtle">deleted session</em>}</span>
                            <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-fg-subtle">
                              {s.kind ?? "—"}
                            </span>
                            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-fg-muted">{fmtCompact(s.outputTokens)} tok</span>
                            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-fg">{fmtTps(s.avgTps)} tok/s</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return iso;
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dd className="tabular-nums text-fg">{value}</dd>
      <dt className="text-[11px] text-fg-subtle">{label}</dt>
    </div>
  );
}

function Tile({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className="text-xl font-semibold tabular-nums text-fg">{value}</span>
        {unit && <span className="text-xs text-fg-subtle">{unit}</span>}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-fg-faint">{hint}</p>}
    </div>
  );
}

const Th = ({ children, right }: { children: ReactNode; right?: boolean }) => (
  <th className={`px-4 py-2 font-medium ${right ? "text-right" : ""}`}>{children}</th>
);
const Td = ({ children, strong }: { children: ReactNode; strong?: boolean }) => (
  <td className={`whitespace-nowrap px-4 py-2 text-right tabular-nums ${strong ? "text-fg" : "text-fg-muted"}`}>{children}</td>
);

function ChartCard({ title, subtitle, table, children }: { title: string; subtitle: string; table: ReactNode; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          <p className="text-xs text-fg-subtle">{subtitle}</p>
        </div>
        <button
          onClick={() => setAsTable((v) => !v)}
          title={asTable ? "Show chart" : "Show as table"}
          aria-label={asTable ? "Show chart" : "Show as table"}
          className="rounded-lg border border-line p-1.5 text-fg-muted hover:bg-fg/5 hover:text-fg"
        >
          {asTable ? <LuChartColumn className="h-3.5 w-3.5" /> : <LuTable2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      {asTable ? <div className="max-h-80 overflow-y-auto">{table}</div> : children}
    </section>
  );
}

// --- charts: plain SVG, sized to their container ---

function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Round-number ticks from zero to a little above the max. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const H = 220;
const M = { top: 12, right: 12, bottom: 26, left: 44 };

interface Tip {
  x: number;
  y: number;
  lines: ReactNode[];
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 12, 0), Math.max(width - 200, 0));
  return (
    <div
      className="pointer-events-none absolute z-10 w-max max-w-[200px] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop"
      style={{ left, top: Math.max(tip.y - 52, 0) }}
    >
      {tip.lines.map((l, i) => (
        <div key={i} className={i === 0 ? "font-medium text-fg" : "text-fg-muted"}>
          {l}
        </div>
      ))}
    </div>
  );
}

function SpeedScatter({ points, avg }: { points: GenerationPoint[]; avg: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const measured = useMemo(() => points.filter((p) => p.tps != null), [points]);

  if (!measured.length) {
    return <div ref={ref} className="grid h-[220px] place-items-center text-xs text-fg-subtle">No measured messages in this range.</div>;
  }
  const times = measured.map((p) => Date.parse(p.at));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = Math.max(t1 - t0, 60_000);
  const ticks = niceTicks(Math.max(...measured.map((p) => p.tps!)));
  const ymax = ticks[ticks.length - 1];
  const iw = Math.max(width - M.left - M.right, 10);
  const ih = H - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - t0) / span) * iw;
  const y = (v: number) => M.top + ih - (v / ymax) * ih;
  const xTicks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);
  const sameDay = new Date(t0).toDateString() === new Date(t1).toDateString();
  const fmtX = (t: number) =>
    sameDay
      ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div ref={ref} className="relative" onMouseLeave={() => (setTip(null), setHover(null))}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Generation speed per message over time">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="rgb(var(--fg-subtle))">
                {v}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 8} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fontSize={10} fill="rgb(var(--fg-subtle))">
              {fmtX(t)}
            </text>
          ))}
          {avg != null && (
            <g>
              <line x1={M.left} x2={width - M.right} y1={y(avg)} y2={y(avg)} stroke="rgb(var(--fg-muted))" strokeWidth={1} strokeDasharray="4 4" />
              <text x={M.left + 4} y={y(avg) - 5} textAnchor="start" fontSize={10} fill="rgb(var(--fg-muted))">
                avg {fmtTps(avg)}
              </text>
            </g>
          )}
          {measured.map((p, i) => (
            <circle
              key={i}
              cx={x(times[i])}
              cy={y(p.tps!)}
              r={hover === i ? 5.5 : 4}
              fill="rgb(var(--accent))"
              fillOpacity={hover === i ? 1 : 0.75}
              stroke="rgb(var(--surface))"
              strokeWidth={2}
            />
          ))}
          {/* Hit targets bigger than the dots, nearest point wins. */}
          <rect
            x={M.left}
            y={M.top}
            width={iw}
            height={ih}
            fill="transparent"
            onMouseMove={(e) => {
              const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
              const mx = e.clientX - box.left;
              const my = e.clientY - box.top;
              let best = -1;
              let bestD = Infinity;
              measured.forEach((p, i) => {
                const d = (x(times[i]) - mx) ** 2 + (y(p.tps!) - my) ** 2;
                if (d < bestD) {
                  bestD = d;
                  best = i;
                }
              });
              if (best < 0 || bestD > 40 ** 2) return setTip(null), setHover(null);
              const p = measured[best];
              setHover(best);
              setTip({
                x: x(times[best]),
                y: y(p.tps!),
                lines: [
                  `${fmtTps(p.tps)} tok/s`,
                  `${fmtInt(p.outputTokens)} tokens${p.ttftMs != null ? ` · first after ${fmtMs(p.ttftMs)}` : ""}`,
                  p.model || "unknown model",
                  new Date(p.at).toLocaleString(),
                ],
              });
            }}
          />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

function DailyBars({ series }: { series: Analytics["series"] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(0, ...series.map((s) => s.outputTokens)));
  const ymax = ticks[ticks.length - 1] || 1;
  const iw = Math.max(width - M.left - M.right, 10);
  const ih = H - M.top - M.bottom;
  const slot = iw / Math.max(series.length, 1);
  // Thin bars with a gap between them; a 2px floor keeps a busy year visible.
  const bw = Math.max(Math.min(slot - 2, 28), 2);
  const y = (v: number) => M.top + ih - (v / ymax) * ih;
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(1, Math.floor(iw / 56))));
  const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });

  return (
    <div ref={ref} className="relative" onMouseLeave={() => (setTip(null), setHover(null))}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Output tokens per day">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={10} fill="rgb(var(--fg-subtle))">
                {fmtCompact(v)}
              </text>
            </g>
          ))}
          {series.map((s, i) => {
            const cx = M.left + slot * i + slot / 2;
            const h = Math.max(ih - (y(s.outputTokens) - M.top), s.outputTokens > 0 ? 2 : 0);
            const r = Math.min(4, bw / 2, h);
            const top = M.top + ih - h;
            const x0 = cx - bw / 2;
            return (
              <g key={s.day}>
                {h > 0 && (
                  // Rounded at the data end only; square on the baseline.
                  <path
                    d={`M${x0},${M.top + ih} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${M.top + ih} Z`}
                    fill="rgb(var(--accent))"
                    fillOpacity={hover === null || hover === i ? 0.9 : 0.45}
                  />
                )}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - 8} textAnchor="middle" fontSize={10} fill="rgb(var(--fg-subtle))">
                    {fmtDay(s.day)}
                  </text>
                )}
                <rect
                  x={M.left + slot * i}
                  y={M.top}
                  width={slot}
                  height={ih}
                  fill="transparent"
                  onMouseMove={() => {
                    setHover(i);
                    setTip({
                      x: cx,
                      y: top,
                      lines: [
                        fmtDay(s.day),
                        `${fmtInt(s.outputTokens)} output tokens`,
                        `${fmtInt(s.generations)} messages${s.avgTps != null ? ` · ${fmtTps(s.avgTps)} tok/s` : ""}`,
                      ],
                    });
                  }}
                />
              </g>
            );
          })}
          <line x1={M.left} x2={width - M.right} y1={M.top + ih} y2={M.top + ih} stroke="rgb(var(--fg-faint))" strokeWidth={1} />
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

function PointsTable({ points }: { points: GenerationPoint[] }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface text-left text-fg-subtle">
        <tr>
          <th className="py-1 pr-3 font-medium">When</th>
          <th className="py-1 pr-3 font-medium">Model</th>
          <th className="py-1 pr-3 text-right font-medium">Tokens</th>
          <th className="py-1 pr-3 text-right font-medium">tok/s</th>
          <th className="py-1 text-right font-medium">First token</th>
        </tr>
      </thead>
      <tbody>
        {[...points].reverse().map((p, i) => (
          <tr key={i} className="border-t border-line text-fg-muted">
            <td className="py-1 pr-3">{new Date(p.at).toLocaleString()}</td>
            <td className="max-w-[12rem] truncate py-1 pr-3">{p.model}</td>
            <td className="py-1 pr-3 text-right tabular-nums">{fmtInt(p.outputTokens)}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-fg">{fmtTps(p.tps)}</td>
            <td className="py-1 text-right tabular-nums">{fmtMs(p.ttftMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DaysTable({ series }: { series: Analytics["series"] }) {
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface text-left text-fg-subtle">
        <tr>
          <th className="py-1 pr-3 font-medium">Day</th>
          <th className="py-1 pr-3 text-right font-medium">Messages</th>
          <th className="py-1 pr-3 text-right font-medium">Output tokens</th>
          <th className="py-1 pr-3 text-right font-medium">Input tokens</th>
          <th className="py-1 text-right font-medium">Avg tok/s</th>
        </tr>
      </thead>
      <tbody>
        {[...series].reverse().map((s) => (
          <tr key={s.day} className="border-t border-line text-fg-muted">
            <td className="py-1 pr-3">{s.day}</td>
            <td className="py-1 pr-3 text-right tabular-nums">{fmtInt(s.generations)}</td>
            <td className="py-1 pr-3 text-right tabular-nums text-fg">{fmtInt(s.outputTokens)}</td>
            <td className="py-1 pr-3 text-right tabular-nums">{fmtInt(s.inputTokens)}</td>
            <td className="py-1 text-right tabular-nums">{fmtTps(s.avgTps)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
