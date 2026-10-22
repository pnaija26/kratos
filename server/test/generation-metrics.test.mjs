import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
const dataDir = mkdtempSync(join(tmpdir(), 'kratos-metrics-'));
process.env.DATA_DIR = dataDir;
const { appendEvent, getDb } = await import('../dist/db.js');
const { GenerationTracker, backfillGenerations, generationRate, generationsForSession, prefillRate } = await import('../dist/metrics.js');
test.after(() => { getDb().close(); rmSync(dataDir, { recursive: true, force: true }); });

const usage = (output, input = 100) => ({ input, output, cacheRead: 5, cacheWrite: 0, totalTokens: input + output, cost: { total: 0.01 } });
const assistant = (output, extra = {}) => ({ role: 'assistant', provider: 'llama', model: 'qwen', usage: usage(output), stopReason: 'stop', content: [], ...extra });

test('wall clock: speed is measured from the first token, not from the request', () => {
  let now = 1_000_000;
  const tracker = new GenerationTracker(() => now);
  tracker.observe('wall', { type: 'message_start', message: { role: 'assistant' } });
  now += 2000; // prefill
  tracker.observe('wall', { type: 'message_update', assistantMessageEvent: { type: 'start' } });
  tracker.observe('wall', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } });
  now += 4000; // 200 tokens over 4 s
  tracker.observe('wall', { type: 'message_end', message: assistant(200) });
  const [g] = generationsForSession('wall');
  assert.equal(g.duration_ms, 6000);
  assert.equal(g.ttft_ms, 2000);
  assert.equal(g.output_tokens, 200);
  assert.equal(g.cache_read, 5);
  assert.equal(Math.round(generationRate(g)), 50);
  assert.equal(prefillRate(g), null);
});

test('llama.cpp timings win over wall clock when they arrive during the message', () => {
  let now = 5_000_000;
  const tracker = new GenerationTracker(() => now);
  tracker.observe('llama', { type: 'message_start', message: { role: 'assistant' } });
  now += 1000;
  tracker.observe('llama', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x' } });
  now += 1000;
  tracker.llamaTimings('llama', { prompt_n: 4000, prompt_ms: 2000, predicted_n: 430, predicted_ms: 10_000 });
  tracker.observe('llama', { type: 'message_end', message: assistant(430) });
  const [g] = generationsForSession('llama');
  assert.equal(generationRate(g), 43);
  assert.equal(prefillRate(g), 2000);
});

test('user messages and messages without usage are not recorded', () => {
  const tracker = new GenerationTracker();
  tracker.observe('skip', { type: 'message_end', message: { role: 'user', content: 'hi' } });
  tracker.observe('skip', { type: 'message_end', message: { role: 'assistant', content: [] } });
  assert.equal(generationsForSession('skip').length, 0);
});

test('stale timings from an earlier request are not attached to a later message', () => {
  let now = 9_000_000;
  const tracker = new GenerationTracker(() => now);
  tracker.llamaTimings('stale', { predicted_n: 10, predicted_ms: 1 });
  now += 60_000;
  tracker.observe('stale', { type: 'message_start', message: { role: 'assistant' } });
  now += 1000;
  tracker.observe('stale', { type: 'message_end', message: assistant(20) });
  const [g] = generationsForSession('stale');
  assert.equal(g.predicted_ms, null);
});

test('backfill reads assistant message_end events once', () => {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key = 'generations_backfilled'").run();
  const end = Date.parse('2026-01-01T00:00:10Z');
  const row = appendEvent('old', 'message_end', { type: 'message_end', message: assistant(100, { timestamp: end - 5000 }) });
  db.prepare('UPDATE events SET created_at = ? WHERE seq = ?').run('2026-01-01 00:00:10', row.seq);
  appendEvent('old', 'message_end', { type: 'message_end', message: { role: 'user', content: 'x' } });
  assert.equal(backfillGenerations(), 1);
  assert.equal(backfillGenerations(), 0);
  const [g] = generationsForSession('old');
  assert.equal(g.source, 'backfill');
  assert.equal(g.duration_ms, 5000);
  assert.equal(generationRate(g), 20);
});
