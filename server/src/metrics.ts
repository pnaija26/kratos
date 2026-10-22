import { eventTime, getDb } from "./db.js";

/**
 * How fast the model is, per assistant message.
 *
 * Two sources, best first. When the session talks to llama.cpp through the
 * portal's proxy, the final stream chunk carries llama-server's own timings —
 * prompt and generation measured separately, to the millisecond, which is the
 * number its web UI shows. Anything else (a cloud provider, the container
 * executor, which bypasses the proxy) gets wall clock measured here: from the
 * request to the first streamed token, and from there to the last.
 */

/** llama-server's `timings` object, as it arrives on the last chunk. */
export interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
}

export interface GenerationRow {
  id: number;
  session_id: string;
  at: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cost: number;
  stop_reason: string;
  duration_ms: number | null;
  ttft_ms: number | null;
  prompt_n: number | null;
  prompt_ms: number | null;
  predicted_n: number | null;
  predicted_ms: number | null;
  source: string;
}

/** Stream events that mean a token has arrived. */
const TOKEN_EVENTS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface InFlight {
  startedAt: number;
  firstTokenAt?: number;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Generation speed in tokens per second, or null when it cannot be told. */
export function generationRate(g: Pick<GenerationRow, "output_tokens" | "duration_ms" | "ttft_ms" | "predicted_n" | "predicted_ms">): number | null {
  if (g.predicted_n && g.predicted_ms && g.predicted_ms > 0) return (g.predicted_n / g.predicted_ms) * 1000;
  if (!g.output_tokens || !g.duration_ms) return null;
  // Time spent generating, not waiting on prefill, when the first token was seen.
  const decode = g.ttft_ms != null && g.duration_ms - g.ttft_ms > 0 ? g.duration_ms - g.ttft_ms : g.duration_ms;
  return decode > 0 ? (g.output_tokens / decode) * 1000 : null;
}

/** Prompt processing speed — only llama.cpp reports it. */
export function prefillRate(g: Pick<GenerationRow, "prompt_n" | "prompt_ms">): number | null {
  return g.prompt_n && g.prompt_ms && g.prompt_ms > 0 ? (g.prompt_n / g.prompt_ms) * 1000 : null;
}

export class GenerationTracker {
  private inFlight = new Map<string, InFlight>();
  /** The last timings llama.cpp reported per session, waiting for message_end. */
  private timings = new Map<string, { at: number; t: LlamaTimings }>();

  constructor(private now: () => number = Date.now) {}

  llamaTimings(sessionId: string, t: LlamaTimings): void {
    this.timings.set(sessionId, { at: this.now(), t });
  }

  /** Fed every pi event. Records a row when an assistant message closes. */
  observe(sessionId: string, msg: any): void {
    const type = msg?.type;
    if (type === "message_start" && msg.message?.role === "assistant") {
      this.inFlight.set(sessionId, { startedAt: this.now() });
      return;
    }
    if (type === "message_update") {
      const state = this.inFlight.get(sessionId);
      if (state && !state.firstTokenAt && TOKEN_EVENTS.has(msg.assistantMessageEvent?.type)) {
        state.firstTokenAt = this.now();
      }
      return;
    }
    if (type !== "message_end" || msg.message?.role !== "assistant") return;

    const message = msg.message;
    const state = this.inFlight.get(sessionId);
    this.inFlight.delete(sessionId);
    const usage = message.usage;
    if (!usage) return;

    const end = this.now();
    // pi stamps the message when it builds the request, before any prefill; the
    // earlier of that and message_start is the closest thing to "asked".
    const stamps = [state?.startedAt, typeof message.timestamp === "number" ? message.timestamp : undefined]
      .filter((v): v is number => typeof v === "number" && v <= end && end - v < 6 * 3600_000);
    const start = stamps.length ? Math.min(...stamps) : undefined;

    // Timings belong to this message only if they arrived while it was open.
    const pending = this.timings.get(sessionId);
    this.timings.delete(sessionId);
    const t = pending && (start === undefined || pending.at >= start - 1000) ? pending.t : undefined;

    recordGeneration({
      session_id: sessionId,
      at: new Date(end).toISOString(),
      provider: String(message.provider ?? ""),
      model: String(message.responseModel || message.model || ""),
      input_tokens: num(usage.input),
      output_tokens: num(usage.output),
      cache_read: num(usage.cacheRead),
      cost: num(usage.cost?.total),
      stop_reason: String(message.stopReason ?? ""),
      duration_ms: start !== undefined ? end - start : null,
      ttft_ms: start !== undefined && state?.firstTokenAt ? state.firstTokenAt - start : null,
      prompt_n: t?.prompt_n ?? null,
      prompt_ms: t?.prompt_ms ?? null,
      predicted_n: t?.predicted_n ?? null,
      predicted_ms: t?.predicted_ms ?? null,
      source: "live",
    });
  }

  forget(sessionId: string): void {
    this.inFlight.delete(sessionId);
    this.timings.delete(sessionId);
  }
}

export function recordGeneration(row: Omit<GenerationRow, "id">): void {
  getDb()
    .prepare(
      `INSERT INTO generations (session_id, at, provider, model, input_tokens, output_tokens, cache_read,
         cost, stop_reason, duration_ms, ttft_ms, prompt_n, prompt_ms, predicted_n, predicted_ms, source)
       VALUES (@session_id, @at, @provider, @model, @input_tokens, @output_tokens, @cache_read,
         @cost, @stop_reason, @duration_ms, @ttft_ms, @prompt_n, @prompt_ms, @predicted_n, @predicted_ms, @source)`,
    )
    .run(row);
}

const BACKFILL_KEY = "generations_backfilled";

/**
 * Fill the table from the event log the first time it exists, so the
 * dashboard opens on the history already there rather than on nothing.
 *
 * Only once: the event log is trimmed, so a second pass would find less, and
 * anything since is recorded live. Times here come from the stored event's
 * second-resolution clock against pi's own millisecond stamp, so they are
 * close for long answers and rough for short ones — marked as such.
 */
export function backfillGenerations(): number {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM settings WHERE key = ?").get(BACKFILL_KEY)) return 0;
  const rows = db
    .prepare(
      `SELECT session_id, payload, created_at FROM events
       WHERE type = 'message_end' AND json_extract(payload, '$.message.role') = 'assistant'
       ORDER BY seq ASC`,
    )
    .all() as { session_id: string; payload: string; created_at: string }[];
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      let message: any;
      try {
        message = JSON.parse(r.payload).message;
      } catch {
        continue;
      }
      const usage = message?.usage;
      if (!usage) continue;
      const end = eventTime(r.created_at);
      if (end === undefined) continue;
      const start = typeof message.timestamp === "number" ? message.timestamp : undefined;
      const duration = start !== undefined && end > start && end - start < 6 * 3600_000 ? end - start : null;
      recordGeneration({
        session_id: r.session_id,
        at: new Date(end).toISOString(),
        provider: String(message.provider ?? ""),
        model: String(message.responseModel || message.model || ""),
        input_tokens: num(usage.input),
        output_tokens: num(usage.output),
        cache_read: num(usage.cacheRead),
        cost: num(usage.cost?.total),
        stop_reason: String(message.stopReason ?? ""),
        duration_ms: duration,
        ttft_ms: null,
        prompt_n: null,
        prompt_ms: null,
        predicted_n: null,
        predicted_ms: null,
        source: "backfill",
      });
      added++;
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(BACKFILL_KEY, new Date().toISOString());
  })();
  return added;
}

export function generationsSince(sinceIso: string): GenerationRow[] {
  return getDb()
    .prepare("SELECT * FROM generations WHERE at >= ? ORDER BY at ASC")
    .all(sinceIso) as GenerationRow[];
}

export function generationsForSession(sessionId: string, limit = 500): GenerationRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM (SELECT * FROM generations WHERE session_id = ? ORDER BY at DESC LIMIT ?) ORDER BY at ASC",
    )
    .all(sessionId, limit) as GenerationRow[];
}

export const generationTracker = new GenerationTracker();
