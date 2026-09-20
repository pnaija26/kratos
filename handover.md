# Handover: Pithagoras local-AI optimization

Context for whichever assistant picks this up next. This repo (`pithagoras`) was
analyzed, discussed, and just moved to a new remote. The work below is what's
left to do, on a different machine ("Cortex") than wherever this file is being
read.

## What this app is

A self-hosted web front end for the `pi` coding agent
(https://github.com/earendil-works/pi), built to run unattended: submit a task,
close the browser, come back later and read what it did. Node/TS server
(Express + better-sqlite3) + React/Vite frontend, deployed via Docker.

Architecture:
```
Browser --SSE (replay + tail)--> portal --JSONL over stdio--> pi --mode rpc
                                    |
                                    +--> SQLite: sessions + full event log
```
Runs are server-owned, not tab-owned. Every pi event is appended to a durable
log; reconnecting replays what was missed (`?since=<id>`) then tails live.
Closing the browser does not stop the run — it's a long-lived process inside
the portal server (or a detached container), not something scoped to the
browser connection.

Two executors: `host` (pi runs in-process in the portal via `SdkPiClient`,
fast, full repo access) and `container` (one hardened, resource-capped Docker
container per task, via `ContainerExecutor`).

## Why this app exists (stated by the user, not inferred)

Built specifically to avoid two bottlenecks seen in another harness ("Hermes"):

1. **Idle token/inference waste** — Hermes shows tokens being consumed even
   when nothing is happening, burning local inference capacity for no work.
2. **No true background execution** — with bare `pi` (or Hermes) as the
   harness, you can't close your laptop and let it keep working; the process
   is tied to your terminal/session.

Both were checked against the actual code and confirmed as deliberate,
structural properties of this app, not just marketing claims:

- Liveness/heartbeat traffic (`server/src/index.ts:660`, `server/src/api/canvases.ts:17`)
  is plain SSE comment pings (`: ping`, `: keepalive`) to keep the *browser*
  connection open — it never touches pi or the model. Session status
  (`idle`/`running`/`error`/`interrupted`, `server/src/db.ts:6`) comes from the
  SDK's own streaming/idle signal (`server/src/pi/sdk-client.ts:490-499`), not
  from polling the model. Between real prompts, the model does zero work.
- Compaction fires as part of a completed turn
  (`server/src/session-manager.ts:336`), not on an idle timer.
- `SdkPiClient` runs pi in-process inside the long-lived portal server;
  `ContainerExecutor` runs it in a detached container. Neither is scoped to a
  browser tab, which is the actual fix for "can't close your laptop."

## The user's local setup

- `llama-server` at `http://192.168.1.101:8080` (a separate box on the LAN,
  not the same host as the portal)
- Model: **qwen3.8-27B-mtp** (multi-token prediction / speculative decoding)
- **256,000 token context**
- **43 tokens/sec** generation
- llama-server is launched directly with fixed CLI flags — **no router/proxy**
  (e.g. no llama-swap) in front of it managing presets.
- Voice stack also present on this deployment (Whisper STT + Breeze TTS via
  `audio-cpp`, GGUF/Q8, tuned pipeline — see `docs/guide/voice-comparison.md`),
  though that history documents tuning done against a *different* model,
  `qwen36-35b-a3b-mtp` (35B-A3B, not the 27B-mtp currently running).

## Optimization findings and decisions

Six candidate optimizations were identified. Several early ones were **wrong**
on reflection — they applied generic "shared harness" assumptions (multi-slot
concurrency, cloud fallback, aggregate dashboards) that don't fit a design
built around one dedicated local model getting full resource commitment. Those
were explicitly retracted:

- ~~Multi-slot KV cache~~ — single-slot + serialized queue
  (`server/src/llama-session-cache.ts`) is correct for one big model at 256K
  context, not a limitation.
- ~~Cloud fallback/routing~~ — would reintroduce network round-trips, external
  API dependency, cost and a privacy boundary crossing — directly against the
  local-first goal. Not wanted.
- ~~Aggregate token/cost telemetry dashboard~~ — likely deliberate minimalism,
  consistent with pi's ~3.8k-token startup budget philosophy. Not pursuing.
- The voice pipeline's staged rollout (demo instance before promoting to
  production, per `docs/guide/voice-comparison.md`) is disciplined A/B
  methodology, not a gap.

**Five items were kept, and the user wants to act on all but #4:**

1. **Retune compaction for the 256K window.**
   `llama-session-cache.ts` keys its disk KV-cache save/restore on a hash of
   `model + session file`. Compaction rewrites session history into a summary,
   which changes that hash and invalidates the cached prefix — forcing a full
   re-prefill of the entire context on the next turn. Prefill (not generation)
   is the expensive part locally (`server/src/llama-progress.ts` exists
   specifically to visualize prefill progress because it dominates turn time).
   pi's default `compaction.keepRecentTokens` is `20000`
   (`server/src/pi-settings.ts:47-50`), sized for roughly a 64K window. At
   256K it's needlessly conservative and triggers more re-prefills than
   necessary.
   **Action:** raise `compaction.keepRecentTokens` in pi's `settings.json`
   (`$HOME/.pi/agent/settings.json` on the portal container, or via Settings →
   Advanced in the UI) to a value proportional to the 256K window.

2. **Verify `LLAMA_DISK_CACHE_MODELS` includes the exact model id.**
   This env var (read in `server/src/llama-progress.ts:133`) gates whether the
   disk KV-cache save/restore path engages at all. It only matters when
   *switching* between sessions/models on the one model slot — llama-server
   already keeps a session's cache live in slot 0 while you stay within it.
   **Action:** confirm the exact model id string pi reports (not just
   "qwen3.8-27B-mtp" from memory — get the literal string from the model
   picker or `/api/settings`) is listed in `LLAMA_DISK_CACHE_MODELS` in the
   portal's env/compose file on Cortex.

3. **Use `EXECUTOR=host` for sessions against the local model, not `container`.**
   Confirmed by code inspection: `proxyBaseUrl`/`startLlamaProxy` (the
   prefill-progress relay and the KV-cache trigger, `server/src/llama-progress.ts`)
   are only imported/used in `server/src/pi/sdk-client.ts`, which is
   exclusively the `HostExecutor` path (`server/src/executors/index.ts`).
   `ContainerExecutor` spawns a fully separate `pi --mode rpc` process in its
   own container talking directly to the model over its own network path —
   it never goes through the portal's loopback proxy. So containerized
   sessions silently lose **both** prefill-progress visibility and KV-cache
   reuse.
   **Action:** default to `EXECUTOR=host` for any session using the local
   model; only use `container` when the isolation is specifically needed for
   that task, accepting the loss of those two features on it.

4. **(Deferred — not being worked on right now.)** Routine/cron scheduling
   contention: the single-slot lane in `llama-session-cache.ts` serializes all
   traffic FIFO, so a cron-scheduled routine (`server/src/routines/cron.ts`)
   firing during interactive use will queue rather than run in parallel or
   preempt. Fine for pure unattended use; worth revisiting if routines and
   interactive sessions start colliding in practice.

5. **Re-benchmark llama-server's `--ubatch-size`/`--batch-size` for the
   current model.** The tuning history in `docs/guide/voice-comparison.md`
   (`ubatch-size=128` vs `1024`, `batch-size=2048`) was measured against
   `qwen36-35b-a3b-mtp`, not the `qwen3.8-27b-mtp` currently running. Since
   llama-server here is launched with fixed CLI flags directly (confirmed by
   the user — no router/llama-swap in front of it), whatever script/systemd
   unit starts it should be checked for these flags, and they should be
   re-benchmarked against the current model rather than assumed carried over
   correctly. Batch/ubatch size trades prefill throughput against
   latency-to-first-token.

6. **Wire up a Telegram channel for background-task completion notifications.**
   User chose Telegram (over Discord/Slack/webhook) for this. Use the existing
   `channels/telegram` package (`channels/telegram/index.js`,
   `channels/telegram/package.json`) — install it via Settings → Channels in
   the portal (or the equivalent config), which will need a bot token and
   chat id. Point is to close the "close the laptop, come back later" loop
   without needing to reopen the browser tab to check status.

## Git/remote state (already done, informational only)

This repo's `origin` was **repointed and force-pushed**:

- Was: `https://github.com/thecodacus/pithagoras.git` (upstream, this repo is
  a fork with local voice-optimization work layered on top — see git log for
  commits like "feature/local-voice-agent-canvases" and "Record the fully
  optimized voice demo configuration").
- Now: `https://github.com/pnaija26/kratos.git`, main branch, force-pushed to
  `5b67cc9` ("fix(voice): migrate managed services to portal network
  namespace (#30)").
- Before this push, `kratos:main` had one prior commit ("pi harness first
  clone") that added `pithagoras` as a **git submodule** pointing at this same
  commit. The user explicitly chose to discard that submodule structure and
  flatten pithagoras's full history directly into `kratos:main` instead. That
  submodule commit is no longer reachable from `main` (may still exist in
  GitHub's internal storage for a time, but is not part of the branch).
- The GitHub account used for this push (`p3iyaji`) was added as a
  collaborator with push access to `pnaija26/kratos` specifically to make this
  push possible — it does not own the repo.

No code changes have been made in this repo yet. Everything in the numbered
list above is still to be done, on Cortex, not in this local checkout.
