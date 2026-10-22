import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LuBot,
  LuClock,
  LuExternalLink,
  LuFolderSearch,
  LuMessageSquare,
  LuPencil,
  LuSearch,
  LuTriangleAlert,
  LuWrench,
  LuPlay,
  LuInfo,
  LuUser,
} from "react-icons/lu";
import { api, type Job, type JobActivity, type JobDetail, type SessionStatus } from "../api";
import { RenameField } from "./RenameField";
import { WorkspaceFiles } from "./WorkspaceFiles";

/**
 * Every job the portal holds — tasks, channel conversations and routine runs —
 * in one place, with what each did, how fast the model went on it, and its
 * workspace to look through or import into.
 *
 * Read-only by design apart from the name and the files: opening a job here
 * does not start pi. "Open chat" is the way in to talk to it.
 */

const STATUS_STYLE: Record<SessionStatus, string> = {
  running: "bg-accent animate-pulse",
  idle: "bg-fg-faint",
  error: "bg-danger",
  interrupted: "bg-warn",
};

const KINDS = [
  { id: "all", label: "All" },
  { id: "task", label: "Tasks" },
  { id: "agent", label: "Agent" },
  { id: "routine", label: "Routines" },
] as const;

const STATUSES: { id: "any" | SessionStatus; label: string }[] = [
  { id: "any", label: "Any status" },
  { id: "running", label: "Running" },
  { id: "idle", label: "Idle" },
  { id: "error", label: "Failed" },
  { id: "interrupted", label: "Interrupted" },
];

type Tab = "overview" | "activity" | "files";

const sqliteMs = (s: string) => Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (!Number.isFinite(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const fmtTps = (n: number | null | undefined) => (n == null ? "—" : n >= 100 ? Math.round(n).toString() : n.toFixed(1));
const fmtMs = (ms: number | null | undefined) =>
  ms == null ? "—" : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
const fmtCompact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);

export function JobsPage({
  jobId,
  onSelectJob,
  onOpenChat,
  onRenamed,
}: {
  jobId: string | null;
  onSelectJob: (id: string | null) => void;
  onOpenChat: (id: string) => void;
  onRenamed: () => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("all");
  const [status, setStatus] = useState<"any" | SessionStatus>("any");

  const load = useCallback(async () => {
    try {
      setJobs((await api.jobs()).jobs);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (jobs ?? []).filter(
      (j) =>
        (kind === "all" || j.kind === kind) &&
        (status === "any" || j.status === status) &&
        (!q || `${j.title} ${j.workspace} ${j.origin?.name ?? ""} ${j.model ?? ""}`.toLowerCase().includes(q)),
    );
  }, [jobs, query, kind, status]);

  const selected = jobs?.find((j) => j.id === jobId) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <aside
        className={`flex min-h-0 flex-col border-line md:w-80 md:shrink-0 md:border-r ${jobId ? "hidden md:flex" : "flex flex-1 md:flex-none"}`}
      >
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex items-center gap-2">
            <LuFolderSearch className="h-4 w-4 text-accent" />
            <h2 className="text-sm font-semibold text-fg">Jobs</h2>
            <span className="ml-auto text-[11px] text-fg-faint">
              {jobs ? `${shown.length} of ${jobs.length}` : ""}
            </span>
          </div>
          <div className="relative">
            <LuSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, workspace, model…"
              className="w-full rounded-lg border border-line bg-raised/60 py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-fg-faint focus:border-accent/60"
            />
          </div>
          <div className="flex items-center gap-2">
            <div role="group" aria-label="Kind" className="flex flex-1 rounded-lg border border-line bg-raised/40 p-0.5">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  onClick={() => setKind(k.id)}
                  aria-pressed={kind === k.id}
                  className={`flex-1 rounded-md px-1.5 py-0.5 text-[11px] transition ${
                    kind === k.id ? "bg-surface text-fg shadow-sm" : "text-fg-subtle hover:text-fg"
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              aria-label="Status"
              className="rounded-lg border border-line bg-raised/60 px-1.5 py-1 text-[11px] text-fg-muted"
            >
              {STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="px-3 py-2 text-xs text-danger">{error}</p>}
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {jobs === null ? (
            <li className="px-3 py-6 text-center text-xs text-fg-subtle">Loading…</li>
          ) : shown.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-fg-subtle">Nothing matches.</li>
          ) : (
            shown.map((j) => (
              <li key={j.id}>
                <button
                  onClick={() => onSelectJob(j.id)}
                  className={`mb-0.5 w-full rounded-lg px-2.5 py-2 text-left transition ${
                    j.id === jobId ? "bg-fg/[0.07]" : "hover:bg-fg/5"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[j.status]}`} title={j.status} />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{j.title}</span>
                    <KindIcon kind={j.kind} />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 pl-4 text-[11px] text-fg-subtle">
                    <span className="min-w-0 flex-1 truncate">{j.origin?.name ?? j.workspace.split(/[\\/]/).pop()}</span>
                    {j.stats.outputTokens > 0 && <span className="shrink-0 tabular-nums">{fmtCompact(j.stats.outputTokens)} tok</span>}
                    <span className="shrink-0">{ago(sqliteMs(j.updated_at))}</span>
                  </div>
                </button>
              </li>
            ))
          )}
        </ul>
      </aside>

      <section className={`min-h-0 min-w-0 flex-1 ${jobId ? "flex" : "hidden md:flex"} flex-col`}>
        {jobId ? (
          <JobView
            key={jobId}
            id={jobId}
            summary={selected}
            onBack={() => onSelectJob(null)}
            onOpenChat={() => onOpenChat(jobId)}
            onRenamed={() => {
              void load();
              onRenamed();
            }}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center">
            <div>
              <LuFolderSearch className="mx-auto h-8 w-8 text-fg-faint" />
              <p className="mt-2 text-sm text-fg-muted">Pick a job to see what it did.</p>
              <p className="mt-1 max-w-xs text-xs text-fg-subtle">
                Its activity, how fast the model ran on it, and its workspace files — including a place to import new ones.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function KindIcon({ kind }: { kind: Job["kind"] }) {
  const map = {
    task: { icon: <LuMessageSquare className="h-3 w-3" />, label: "Task" },
    agent: { icon: <LuBot className="h-3 w-3" />, label: "Agent conversation" },
    routine: { icon: <LuClock className="h-3 w-3" />, label: "Routine run" },
  } as const;
  const k = map[kind] ?? map.task;
  return (
    <span className="shrink-0 text-fg-faint" title={k.label} aria-label={k.label}>
      {k.icon}
    </span>
  );
}

function JobView({
  id,
  summary,
  onBack,
  onOpenChat,
  onRenamed,
}: {
  id: string;
  summary: Job | null;
  onBack: () => void;
  onOpenChat: () => void;
  onRenamed: () => void;
}) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [renaming, setRenaming] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await api.job(id, 300));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  const running = (summary ?? detail?.job)?.status === "running";
  useEffect(() => {
    void load();
    // Fast while it is working, so the activity reads like a live log.
    const t = setInterval(() => void load(), running ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, running]);

  const job = detail?.job ?? summary;
  if (!job) {
    return <div className="grid flex-1 place-items-center text-sm text-fg-subtle">{error ?? "Loading…"}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b border-line px-4 py-3">
        <button onClick={onBack} className="mb-1 text-xs text-fg-subtle hover:text-fg md:hidden">
          ← All jobs
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_STYLE[job.status]}`} title={job.status} />
          <h2
            className="group/title flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold text-fg"
            onDoubleClick={() => setRenaming(true)}
          >
            <RenameField
              value={job.title}
              editing={renaming}
              onDone={() => setRenaming(false)}
              onSave={async (title) => {
                await api.renameSession(job.id, title);
                await load();
                onRenamed();
              }}
            />
            {!renaming && (
              <button
                onClick={() => setRenaming(true)}
                title="Rename"
                aria-label="Rename job"
                className="shrink-0 rounded p-1 text-fg-faint opacity-0 transition hover:text-accent focus:opacity-100 group-hover/title:opacity-100"
              >
                <LuPencil className="h-3.5 w-3.5" />
              </button>
            )}
          </h2>
          <button
            onClick={onOpenChat}
            className="flex items-center gap-1.5 rounded-lg bg-accent/12 px-2.5 py-1 text-xs text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20"
          >
            <LuExternalLink className="h-3.5 w-3.5" /> Open chat
          </button>
        </div>
        <p className="mt-0.5 truncate pl-[18px] font-mono text-[11px] text-fg-faint">{job.workspace}</p>
        <nav role="tablist" className="mt-3 flex gap-1">
          {(["overview", "activity", "files"] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1 text-xs capitalize transition ${
                tab === t ? "bg-fg/[0.07] text-fg" : "text-fg-subtle hover:bg-fg/5 hover:text-fg"
              }`}
            >
              {t}
              {t === "activity" && detail ? <span className="ml-1 text-fg-faint">{detail.activity.length}</span> : null}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && <p className="mb-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        {tab === "overview" && <Overview job={job} detail={detail} />}
        {tab === "activity" && <ActivityList items={detail?.activity ?? null} running={job.status === "running"} />}
        {tab === "files" && <WorkspaceFiles sessionId={job.id} workspace={job.workspace} className="h-full" />}
      </div>
    </div>
  );
}

function Overview({ job, detail }: { job: Job; detail: JobDetail | null }) {
  const speed = detail?.speed;
  const rows: [string, ReactNode][] = [
    ["Kind", job.kind === "task" ? "Task" : job.kind === "agent" ? "Agent conversation" : "Routine run"],
    ["Status", job.status + (job.live ? " · pi loaded" : "")],
    ...(job.origin ? ([[job.origin.type === "routine" ? "Routine" : "Channel", job.origin.name]] as [string, ReactNode][]) : []),
    ["Model", job.model ? `${job.provider ? `${job.provider} / ` : ""}${job.model}` : "portal default"],
    ["Executor", job.executor],
    ["Created", new Date(sqliteMs(job.created_at)).toLocaleString()],
    ["Last activity", `${new Date(sqliteMs(job.updated_at)).toLocaleString()} (${ago(sqliteMs(job.updated_at))})`],
    ["Stored events", detail ? detail.events.count.toLocaleString() : "…"],
    ["Job id", <span className="font-mono">{job.id}</span>],
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {job.last_error && (
        <div className="flex gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
          <LuTriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="break-words">{job.last_error}</span>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Avg speed" value={fmtTps(speed?.avgTps)} unit="tok/s" />
        <Stat label="First token" value={fmtMs(speed?.avgTtftMs)} unit="avg" />
        <Stat label="Output" value={fmtCompact(job.stats.outputTokens)} unit="tokens" />
        <Stat label="Messages" value={String(job.stats.generations)} unit={job.stats.cost > 0 ? `$${job.stats.cost.toFixed(2)}` : "generated"} />
      </div>
      <dl className="divide-y divide-line rounded-xl border border-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex gap-3 px-3 py-2 text-sm">
            <dt className="w-32 shrink-0 text-fg-subtle">{k}</dt>
            <dd className="min-w-0 flex-1 break-words text-fg-muted">{v}</dd>
          </div>
        ))}
      </dl>
      {detail && detail.generations.length > 0 && (
        <div className="rounded-xl border border-line">
          <h3 className="border-b border-line px-3 py-2 text-xs font-medium text-fg-muted">Recent messages</h3>
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-fg-subtle">
                <tr>
                  <th className="px-3 py-1.5 font-medium">When</th>
                  <th className="px-3 py-1.5 text-right font-medium">Tokens</th>
                  <th className="px-3 py-1.5 text-right font-medium">tok/s</th>
                  <th className="px-3 py-1.5 text-right font-medium">Prefill tok/s</th>
                  <th className="px-3 py-1.5 text-right font-medium">First token</th>
                </tr>
              </thead>
              <tbody>
                {[...detail.generations].reverse().slice(0, 50).map((g, i) => (
                  <tr key={i} className="border-t border-line text-fg-muted">
                    <td className="px-3 py-1.5">{new Date(g.at).toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{g.outputTokens.toLocaleString()}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-fg">{fmtTps(g.tps)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtTps(g.prefillTps)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtMs(g.ttftMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="rounded-xl border border-line bg-raised/30 px-3 py-2">
      <p className="text-[11px] text-fg-subtle">{label}</p>
      <p className="flex items-baseline gap-1">
        <span className="text-lg font-semibold tabular-nums text-fg">{value}</span>
        <span className="text-[11px] text-fg-faint">{unit}</span>
      </p>
    </div>
  );
}

const ACTIVITY_ICON: Record<JobActivity["kind"], ReactNode> = {
  prompt: <LuUser className="h-3.5 w-3.5" />,
  assistant: <LuBot className="h-3.5 w-3.5" />,
  tool: <LuWrench className="h-3.5 w-3.5" />,
  error: <LuTriangleAlert className="h-3.5 w-3.5" />,
  notice: <LuInfo className="h-3.5 w-3.5" />,
  run: <LuPlay className="h-3.5 w-3.5" />,
};

function ActivityList({ items, running }: { items: JobActivity[] | null; running: boolean }) {
  if (items === null) return <p className="py-8 text-center text-xs text-fg-subtle">Loading…</p>;
  if (!items.length) return <p className="py-8 text-center text-xs text-fg-subtle">No activity recorded for this job yet.</p>;
  return (
    <ol className="mx-auto max-w-3xl space-y-1.5">
      {items.map((a) => (
        <li key={`${a.seq}-${a.kind}`} className="flex gap-2.5">
          <span
            className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${
              a.kind === "error" || a.failed
                ? "bg-danger/12 text-danger"
                : a.kind === "assistant"
                  ? "bg-accent/12 text-accent"
                  : "bg-raised text-fg-subtle"
            }`}
          >
            {ACTIVITY_ICON[a.kind]}
          </span>
          <div className="min-w-0 flex-1">
            {a.kind === "tool" ? (
              <p className="text-xs text-fg-muted">
                <span className={`font-medium ${a.failed ? "text-danger" : "text-fg"}`}>{a.text}</span>
                {a.detail && <span className="ml-1.5 break-all font-mono text-[11px] text-fg-subtle">{a.detail}</span>}
                {a.failed && <span className="ml-1.5 text-danger">failed</span>}
              </p>
            ) : a.kind === "run" ? (
              <p className="text-[11px] uppercase tracking-wider text-fg-faint">{a.text}</p>
            ) : (
              <p
                className={`whitespace-pre-wrap break-words text-sm ${
                  a.kind === "error" ? "text-danger" : a.kind === "prompt" ? "text-fg" : "text-fg-muted"
                }`}
              >
                {a.text}
              </p>
            )}
            {a.at && <p className="text-[10px] text-fg-faint">{new Date(a.at).toLocaleString()}</p>}
          </div>
        </li>
      ))}
      {running && <li className="pl-8 text-xs text-accent">Working…</li>}
    </ol>
  );
}
