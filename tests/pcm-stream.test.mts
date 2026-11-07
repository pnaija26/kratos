import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preparePcmSpeech } from '../web/src/pcm-stream.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function audio() {
  const sources: any[] = [];
  return { sources, context: {
    currentTime: 1,
    createBuffer: (_channels: number, count: number, rate: number) => ({ duration: count / rate, getChannelData: () => new Float32Array(count) }),
    createBufferSource: () => {
      const source = { buffer: null, onended: null as any, stopped: false, at: 0,
        connect() {}, disconnect() {}, start(at: number) { this.at = at; }, stop() { this.stopped = true; } };
      sources.push(source); return source;
    },
  } as unknown as AudioContext };
}
/** A clock advancing half a second per reading: 0.67 s chunks arrive faster than realtime. */
const fast = () => { let t = 0; return () => (t += 0.5); };
test('PCM starts before generation ends and schedules incoming chunks contiguously', async () => {
  const { context, sources } = audio(); const abort = new AbortController();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  const ready = preparePcmSpeech(body, context, abort.signal, fast());
  writer.enqueue(new Uint8Array(32001)); // also exercise split 16-bit samples
  writer.enqueue(new Uint8Array(31999));
  const speech = await ready;
  let generated = false; void speech.completed.then(() => { generated = true; });
  let started = false;
  const playing = speech.play({} as AudioNode, () => { started = true; });
  assert.equal(started, true); assert.equal(generated, false);
  writer.enqueue(new Uint8Array(16000)); await tick();
  assert.equal(sources.length, 3);
  assert.equal(sources[2].at, sources[1].at + sources[1].buffer.duration);
  writer.close(); await speech.completed;
  for (const source of sources) source.onended();
  await playing;
});
test('barge-in cancels both streaming reads and scheduled audio', async () => {
  const { context, sources } = audio(); const abort = new AbortController(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(32000)); c.enqueue(new Uint8Array(32000)); }, cancel() { cancelled = true; } });
  const speech = await preparePcmSpeech(body, context, abort.signal, fast());
  const playing = speech.play({} as AudioNode, () => {});
  abort.abort(new Error('interrupted'));
  await assert.rejects(playing, /interrupted/);
  await assert.rejects(speech.completed, /interrupted/);
  assert.equal(cancelled, true); assert.ok(sources.every(s => s.stopped));
});
test('slower-than-realtime synthesis buffers the whole phrase instead of breaking mid-word', async () => {
  const { context, sources } = audio(); const abort = new AbortController();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  let t = 0; // 0.67 s of audio every 1.5 s: 0.44x realtime, as on a GPU busy with the LLM
  let ready = false; const prepared = preparePcmSpeech(body, context, abort.signal, () => (t += 1.5));
  void prepared.then(() => { ready = true; });
  for (let i = 0; i < 4; i++) { writer.enqueue(new Uint8Array(32000)); await tick(); }
  assert.equal(ready, false);
  writer.close();
  const speech = await prepared;
  const playing = speech.play({} as AudioNode, () => {});
  assert.equal(sources.length, 4);
  for (let i = 1; i < 4; i++) assert.equal(sources[i].at, sources[i - 1].at + sources[i - 1].buffer.duration);
  for (const source of sources) source.onended();
  await playing;
});
