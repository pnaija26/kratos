import express, { type Router } from "express";
import { eventTime, getDb, getSession, type SessionRow } from "../db.js";
import {
  generationRate,
  generationsForSession,
  generationsSince,
  prefillRate,
  type GenerationRow,
} from "../metrics.js";
import { sessions } from "../session-manager.js";

/**
 * Read-only views over what the portal has done: the dashboard's numbers and
 * the job browser. Nothing here starts pi or touches a run.
 */

/** Milliseconds actually spent producing tokens, by the best source a row has. */
function decodeMs(g: GenerationRow): number | null {
  if (g.predicted_n && g.predicted_ms && g.predicted_ms > 0) return g.predicted_ms;
  if (!g.duration_ms) return null;
  const d = g.ttft_ms != null && g.duration_ms - g.ttft_ms > 0 ? g.duration_ms - g.ttft_ms : g.duration_ms;
  return d > 0 ? d : null;
}

function decodeTokens(g: GenerationRow): number {
  return g.predicted_n && g.predicted_ms ? g.predicted_n : g.output_tokens;
}

/**
 * Summary speeds for a set of generations.
 *
 * The average is weighted by tokens — total produced over total time spent
 * producing — so a three-token reply that happened to be quick does not count
 * the same as a two-thousand-token one. Very short messages are left out of
 * the speed figures for the same reason: their timing is mostly overhead.
 */
function speeds(rows: GenerationRow[]) {
  let tokens = 0;
  let ms = 0;
  let promptTokens = 0;
  let promptMs = 0;
  const rates: number[] = [];
  const ttfts: number[] = [];
  for (const g of rows) {
    const d = decodeMs(g);
    const n = decodeTokens(g);
    if (d && n >= MIN_TOKENS_FOR_RATE) {
      tokens += n;
      ms += d;
      const r = generationRate(g);
      if (r !== null) rates.push(r);
    }
    if (g.prompt_n && g.prompt_ms) {
      promptTokens += g.prompt_n;
      promptMs += g.prompt_ms;
    }
    if (g.ttft_ms != null && g.ttft_ms >= 0) ttfts.push(g.ttft_ms);
  }
  rates.sort((a, b) => a - b);
  const pct = (p: number) => (rates.length ? rates[Math.min(rates.length - 1, Math.floor(p * rates.length))] : null);
  return {
    avgTps: ms > 0 ? (tokens / ms) * 1000 : null,
    medianTps: pct(0.5),
    p10Tps: pct(0.1),
    p90Tps: pct(0.9),
    peakTps: rates.length ? rates[rates.length - 1] : null,
    avgPrefillTps: promptMs > 0 ? (promptTokens / promptMs) * 1000 : null,
    avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
    measured: rates.length,
  };
}

const MIN_TOKENS_FOR_RATE = 8;

const RANGES: Record<string, number | null> = { "1": 1, "7": 7, "30": 30, "90": 90, all: null };

function point(g: GenerationRow) {
  return {
    at: g.at,
    sessionId: g.session_id,
    model: g.model,
    outputTokens: g.output_tokens,
    inputTokens: g.input_tokens,
    tps: decodeTokens(g) >= MIN_TOKENS_FOR_RATE ? generationRate(g) : null,
    prefillTps: prefillRate(g),
    ttftMs: g.ttft_ms,
    durationMs: g.duration_ms,
    exact: Boolean(g.predicted_ms),
    source: g.source,
  };
}

/** One line of a job's activity, boiled down from its stored events. */
interface ActivityItem {
  seq: number;
  at?: number;
  kind: "prompt" | "assistant" | "tool" | "error" | "notice" | "run";
  text: string;
  detail?: string;
  failed?: boolean;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function toolDetail(p: any): string | undefined {
  const input = p.args ?? p.input ?? p.parameters;
  if (!input) return undefined;
  if (typeof input === "string") return clip(input, 160);
  const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url;
  return clip(typeof first === "string" ? first : JSON.stringify(input), 160);
}

function activity(sessionId: string, limit: number): ActivityItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT seq, type, payload, created_at FROM events
         WHERE session_id = ? AND type IN ('portal_prompt', 'message_end', 'tool_execution_start',
           'tool_execution_end', 'portal_status', 'portal_notice', 'agent_start')
         ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    )
    .all(sessionId, limit * 2) as { seq: number; type: string; payload: string; created_at: string }[];
  const out: ActivityItem[] = [];
  const toolIndex = new Map<string, ActivityItem>();
  for (const r of rows) {
    let p: any;
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    const at = eventTime(r.created_at);
    switch (r.type) {
      case "portal_prompt":
        out.push({ seq: r.seq, at, kind: "prompt", text: clip(String(p.message ?? ""), 1200) });
        break;
      case "message_end": {
        if (p.message?.role !== "assistant") break;
        const content = Array.isArray(p.message.content) ? p.message.content : [];
        const text = content
          .filter((c: any) => c?.type === "text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join("\n")
          .replace(/<\/?think(ing)?>/gi, "")
          .trim();
        if (p.message.stopReason === "error" && p.message.errorMessage) {
          out.push({ seq: r.seq, at, kind: "error", text: clip(String(p.message.errorMessage), 600) });
        }
        if (text) out.push({ seq: r.seq, at, kind: "assistant", text: clip(text, 2000) });
        break;
      }
      case "tool_execution_start": {
        const item: ActivityItem = {
          seq: r.seq,
          at,
          kind: "tool",
          text: String(p.toolName ?? p.name ?? "tool"),
          detail: toolDetail(p),
        };
        if (p.toolCallId) toolIndex.set(String(p.toolCallId), item);
        out.push(item);
        break;
      }
      case "tool_execution_end": {
        const item = p.toolCallId ? toolIndex.get(String(p.toolCallId)) : undefined;
        if (item && p.isError) item.failed = true;
        break;
      }
      case "portal_status":
        if (p.status === "error") out.push({ seq: r.seq, at, kind: "error", text: clip(String(p.error ?? "Run failed"), 600) });
        break;
      case "portal_notice":
        if (typeof p.text === "string" && p.text.trim()) {
          out.push({ seq: r.seq, at, kind: p.error ? "error" : "notice", text: clip(p.text.trim(), 800) });
        }
        break;
      case "agent_start":
        out.push({ seq: r.seq, at, kind: "run", text: "Run started" });
        break;
    }
  }
  return out.slice(-limit);
}

interface JobAggregate {
  session_id: string;
  generations: number;
  output_tokens: number;
  input_tokens: number;
  cost: number;
  last_at: string | null;
}

function jobRow(s: SessionRow, agg: JobAggregate | undefined, routines: Map<string, string>, channels: Map<string, string>) {
  return {
    id: s.id,
    title: s.title,
    kind: s.kind,
    status: s.status,
    workspace: s.workspace,
    executor: s.executor,
    pinned: Boolean(s.pinned),
    live: sessions.isRunning(s.id),
    created_at: s.created_at,
    updated_at: s.updated_at,
    last_error: s.last_error,
    model: s.model,
    provider: s.provider,
    /** What the job belongs to, by name: its routine, or the channel it came in on. */
    origin:
      s.kind === "routine" && s.routine_slug
        ? { type: "routine", slug: s.routine_slug, name: routines.get(s.routine_slug) ?? s.routine_slug }
        : s.kind === "agent" && s.channel_slug
          ? { type: "channel", slug: s.channel_slug, name: channels.get(s.channel_slug) ?? s.channel_slug }
          : null,
    stats: {
      generations: agg?.generations ?? 0,
      outputTokens: agg?.output_tokens ?? 0,
      inputTokens: agg?.input_tokens ?? 0,
      cost: agg?.cost ?? 0,
      lastGenerationAt: agg?.last_at ?? null,
    },
  };
}

function lookups() {
  const db = getDb();
  const routines = new Map(
    (db.prepare("SELECT slug, name FROM routines").all() as { slug: string; name: string }[]).map((r) => [r.slug, r.name]),
  );
  const channels = new Map(
    (db.prepare("SELECT slug, name FROM channels").all() as { slug: string; name: string }[]).map((c) => [c.slug, c.name]),
  );
  return { routines, channels };
}

export function insightsRouter(): Router {
  const router = express.Router();

  router.get("/analytics", (req, res) => {
    const key = String(req.query.days ?? "7");
    const days = key in RANGES ? RANGES[key] : 7;
    // Minutes east of UTC is what the day buckets are cut on, so "today" is the
    // viewer's today and not the server's.
    const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
    const since = days === null ? "0000" : new Date(Date.now() - days * 86400_000).toISOString();
    const rows = generationsSince(since);

    const byDay = new Map<string, GenerationRow[]>();
    const byModel = new Map<string, GenerationRow[]>();
    const bySession = new Map<string, GenerationRow[]>();
    const add = (map: Map<string, GenerationRow[]>, key: string, g: GenerationRow) => {
      const list = map.get(key);
      if (list) list.push(g);
      else map.set(key, [g]);
    };
    for (const g of rows) {
      add(byDay, new Date(Date.parse(g.at) + tz * 60_000).toISOString().slice(0, 10), g);
      add(byModel, `${g.provider}\u0000${g.model}`, g);
      add(bySession, g.session_id, g);
    }
    const sum = (list: GenerationRow[], f: (g: GenerationRow) => number) => list.reduce((a, g) => a + f(g), 0);

    // Every day in the range, including the empty ones — a gap in a chart
    // should look like a gap, not like the line carrying straight on.
    const series: { day: string; generations: number; outputTokens: number; inputTokens: number; avgTps: number | null }[] = [];
    if (rows.length) {
      const dayOf = (ms: number) => new Date(ms + tz * 60_000).toISOString().slice(0, 10);
      const first = dayOf(days === null ? Date.parse(rows[0].at) : Date.now() - (days - 1) * 86400_000);
      const last = dayOf(Date.now());
      for (let t = Date.parse(`${first}T00:00:00Z`); ; t += 86400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        if (day > last) break;
        const list = byDay.get(day) ?? [];
        series.push({
          day,
          generations: list.length,
          outputTokens: sum(list, (g) => g.output_tokens),
          inputTokens: sum(list, (g) => g.input_tokens),
          avgTps: list.length ? speeds(list).avgTps : null,
        });
      }
    }

    const titles = new Map(
      (getDb().prepare("SELECT id, title, kind FROM sessions").all() as { id: string; title: string; kind: string }[]).map(
        (s) => [s.id, s],
      ),
    );

    const jobs = getDb()
      .prepare("SELECT kind, status, count(*) AS n FROM sessions GROUP BY kind, status")
      .all() as { kind: string; status: string; n: number }[];

    const latest = [...rows].reverse().find((g) => decodeTokens(g) >= MIN_TOKENS_FOR_RATE && generationRate(g) !== null);

    res.json({
      range: { days, since: days === null ? null : since },
      totals: {
        generations: rows.length,
        outputTokens: sum(rows, (g) => g.output_tokens),
        inputTokens: sum(rows, (g) => g.input_tokens),
        cacheRead: sum(rows, (g) => g.cache_read),
        cost: sum(rows, (g) => g.cost),
        sessions: bySession.size,
        estimated: rows.filter((g) => g.source === 'backfill').length,
        ...speeds(rows),
      },
      latest: latest ? point(latest) : null,
      series,
      // The most recent few hundred, for the scatter of speed over time.
      points: rows.slice(-400).map(point),
      models: [...byModel.values()]
        .map((list) => ({
          provider: list[0].provider,
          model: list[0].model,
          generations: list.length,
          outputTokens: sum(list, (g) => g.output_tokens),
          inputTokens: sum(list, (g) => g.input_tokens),
          cost: sum(list, (g) => g.cost),
          ...speeds(list),
        }))
        .sort((a, b) => b.outputTokens - a.outputTokens),
      sessions: [...bySession.entries()]
        .map(([id, list]) => ({
          id,
          title: titles.get(id)?.title ?? null,
          kind: titles.get(id)?.kind ?? null,
          generations: list.length,
          outputTokens: sum(list, (g) => g.output_tokens),
          ...speeds(list),
        }))
        .sort((a, b) => b.outputTokens - a.outputTokens)
        .slice(0, 10),
      jobs: {
        total: jobs.reduce((a, j) => a + j.n, 0),
        byStatus: Object.fromEntries(
          ["running", "idle", "error", "interrupted"].map((s) => [s, jobs.filter((j) => j.status === s).reduce((a, j) => a + j.n, 0)]),
        ),
        byKind: Object.fromEntries(
          ["task", "agent", "routine"].map((k) => [k, jobs.filter((j) => j.kind === k).reduce((a, j) => a + j.n, 0)]),
        ),
      },
    });
  });

  /** Every session of every kind — tasks, channel conversations, routine runs. */
  router.get("/jobs", (_req, res) => {
    const db = getDb();
    const all = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[];
    const aggs = new Map(
      (
        db
          .prepare(
            `SELECT session_id, count(*) AS generations, sum(output_tokens) AS output_tokens,
               sum(input_tokens) AS input_tokens, sum(cost) AS cost, max(at) AS last_at
             FROM generations GROUP BY session_id`,
          )
          .all() as JobAggregate[]
      ).map((a) => [a.session_id, a]),
    );
    const { routines, channels } = lookups();
    res.json({ jobs: all.map((s) => jobRow(s, aggs.get(s.id), routines, channels)) });
  });

  router.get("/jobs/:id", (req, res) => {
    const s = getSession(req.params.id);
    if (!s) return res.status(404).json({ error: "Not found" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 20), 1000);
    const gens = generationsForSession(s.id);
    const agg: JobAggregate = {
      session_id: s.id,
      generations: gens.length,
      output_tokens: gens.reduce((a, g) => a + g.output_tokens, 0),
      input_tokens: gens.reduce((a, g) => a + g.input_tokens, 0),
      cost: gens.reduce((a, g) => a + g.cost, 0),
      last_at: gens.at(-1)?.at ?? null,
    };
    const { routines, channels } = lookups();
    const events = getDb()
      .prepare("SELECT count(*) AS n, min(created_at) AS first, max(created_at) AS last FROM events WHERE session_id = ?")
      .get(s.id) as { n: number; first: string | null; last: string | null };
    res.json({
      job: jobRow(s, agg, routines, channels),
      speed: speeds(gens),
      generations: gens.slice(-100).map(point),
      events: { count: events.n, first: eventTime(events.first ?? undefined) ?? null, last: eventTime(events.last ?? undefined) ?? null },
      activity: activity(s.id, limit),
    });
  });

  return router;
}
