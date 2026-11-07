import { useEffect, useRef, useState } from "react";
import {
  LuAppWindow,
  LuExternalLink,
  LuMaximize,
  LuMonitor,
  LuRefreshCw,
  LuRotateCw,
  LuSmartphone,
  LuTablet,
} from "react-icons/lu";
import { api, type PreviewStatus } from "../api";

/**
 * The app being built, beside the conversation building it.
 *
 * Framed from the portal's preview port, which forwards to a dev server on the
 * Kratos host — see server/src/preview.ts for why it is a port and not a path.
 * The frame is another origin, so its address cannot be read back: the bar
 * says where it was sent, not where it has since navigated.
 */

const VIEWPORTS = [
  { id: "fill", label: "Fill the panel", width: null, Icon: LuMonitor },
  { id: "tablet", label: "Tablet (768px)", width: 768, Icon: LuTablet },
  { id: "phone", label: "Phone (390px)", width: 390, Icon: LuSmartphone },
] as const;

const OTHER = "other";

interface Target {
  port: number;
  path: string;
}

/** Per session: each one is usually building its own app. */
const storageKey = (sessionId: string) => `preview:${sessionId}`;
function remembered(sessionId: string): Target | null {
  try {
    const t = JSON.parse(localStorage.getItem(storageKey(sessionId)) ?? "null");
    return t && Number.isInteger(t.port) && typeof t.path === "string" ? t : null;
  } catch {
    return null;
  }
}
function remember(sessionId: string, target: Target): void {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(target));
  } catch {
    // A preference, not state — losing it costs one click.
  }
}

const normalisePath = (p: string) => (p.trim().startsWith("/") ? p.trim() : `/${p.trim()}`);

export function PreviewPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [target, setTarget] = useState<Target | null>(() => remembered(sessionId));
  const [address, setAddress] = useState(() => remembered(sessionId)?.path ?? "/");
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  // Bumped to remount the frame: reload, and the same URL entered again.
  const [generation, setGeneration] = useState(0);
  const [viewport, setViewport] = useState<(typeof VIEWPORTS)[number]["id"]>("fill");
  const wrap = useRef<HTMLDivElement>(null);

  const scan = async () => {
    setScanning(true);
    try {
      const s = await api.preview();
      setStatus(s);
      setError(null);
      return s;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    scan().then((s) => {
      // One app running and nothing chosen yet: that is the one.
      if (s && s.servers.length === 1) setTarget((t) => t ?? { port: s.servers[0].port, path: "/" });
    });
  }, []);

  const go = (next: Target) => {
    setTarget(next);
    setAddress(next.path);
    setGeneration((g) => g + 1);
    remember(sessionId, next);
  };

  // Built here: the server does not reliably know the hostname you reached it on.
  const origin = status?.port ? `${window.location.protocol}//${window.location.hostname}:${status.port}` : null;
  const src =
    origin && target
      ? `${origin}/__kratos_preview/open?port=${target.port}&path=${encodeURIComponent(target.path)}`
      : null;

  const servers = status?.servers ?? [];
  const known = target && servers.some((s) => s.port === target.port);
  const view = VIEWPORTS.find((v) => v.id === viewport)!;
  const nextView = VIEWPORTS[(VIEWPORTS.indexOf(view) + 1) % VIEWPORTS.length];

  const button = "rounded p-1 text-fg-faint transition hover:bg-fg/5 hover:text-fg disabled:opacity-40";

  return (
    <div ref={wrap} className="flex h-full min-h-0 flex-col bg-canvas [&:fullscreen]:h-screen">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5">
        <LuAppWindow className="ml-1 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        {typing ? (
          <input
            autoFocus
            inputMode="numeric"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom) {
                go({ port: Number(custom), path: normalisePath(address) });
                setTyping(false);
              }
              if (e.key === "Escape") setTyping(false);
            }}
            onBlur={() => setTyping(false)}
            placeholder="port"
            className="w-16 shrink-0 rounded border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-accent/60"
          />
        ) : (
          <select
            value={target ? String(target.port) : ""}
            onChange={(e) => {
              if (e.target.value === OTHER) {
                setCustom(target ? String(target.port) : "");
                setTyping(true);
              } else if (e.target.value) {
                go({ port: Number(e.target.value), path: "/" });
              }
            }}
            title="Which app to preview"
            className="max-w-[11rem] shrink-0 truncate rounded border border-line bg-raised/60 px-1 py-0.5 text-[11px] text-fg outline-none focus:border-accent/60"
          >
            {!target && <option value="">Pick an app…</option>}
            {servers.map((s) => (
              <option key={s.port} value={s.port}>
                :{s.port}
                {s.title ? ` · ${s.title}` : ""}
              </option>
            ))}
            {target && !known && <option value={target.port}>:{target.port}</option>}
            <option value={OTHER}>Other port…</option>
          </select>
        )}
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && target) go({ port: target.port, path: normalisePath(address) });
          }}
          disabled={!target}
          spellCheck={false}
          title="Path inside the app — Enter to go"
          className="min-w-0 flex-1 rounded border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[11px] text-fg outline-none focus:border-accent/60 disabled:opacity-40"
        />
        <button onClick={() => setGeneration((g) => g + 1)} disabled={!src} title="Reload" className={button}>
          <LuRotateCw className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setViewport(nextView.id)}
          title={`${view.label} — click for ${nextView.label.toLowerCase()}`}
          className={button}
        >
          <view.Icon className="h-3.5 w-3.5" />
        </button>
        {src ? (
          <a href={src} target="_blank" rel="noreferrer" title="Open in a new tab" className={button}>
            <LuExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : (
          <button disabled className={button}>
            <LuExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <button onClick={() => wrap.current?.requestFullscreen?.()} title="Fullscreen" className={button}>
          <LuMaximize className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onClose}
          title="Collapse"
          className="rounded px-1.5 py-0.5 text-[11px] text-fg-faint transition hover:text-fg"
        >
          ✕
        </button>
      </div>

      {src ? (
        <div className={`min-h-0 flex-1 overflow-auto ${view.width ? "bg-fg/5 p-3" : ""}`}>
          <iframe
            key={`${src}#${generation}`}
            src={src}
            title="App preview"
            className="mx-auto block h-full border-0 bg-white"
            style={{ width: view.width ? `${view.width}px` : "100%" }}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 text-xs text-fg-muted">
          {error && <p className="mb-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-danger">{error}</p>}
          {!status && !error && <p className="text-fg-subtle">Looking for running apps…</p>}
          {status && !status.port && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2">
              Previews are unavailable. {status.error ?? "The preview listener is not running."}
            </p>
          )}
          {status?.port && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <p className="font-medium text-fg">Running on this machine</p>
                <button onClick={scan} disabled={scanning} title="Look again" className={button}>
                  <LuRefreshCw className={`h-3 w-3 ${scanning ? "animate-spin" : ""}`} />
                </button>
              </div>
              {servers.length ? (
                <ul className="mb-4 space-y-1">
                  {servers.map((s) => (
                    <li key={s.port}>
                      <button
                        onClick={() => go({ port: s.port, path: "/" })}
                        className="flex w-full items-center gap-2 rounded-lg border border-line bg-raised/40 px-3 py-2 text-left transition hover:bg-fg/5"
                      >
                        <span className="font-mono text-fg">:{s.port}</span>
                        <span className="min-w-0 flex-1 truncate text-fg-muted">{s.title ?? "Untitled"}</span>
                        {s.status >= 400 && <span className="shrink-0 text-[10px] text-warn">{s.status}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-4 rounded-lg border border-dashed border-line px-3 py-4 text-center text-fg-faint">
                  No web servers found. Start one in the terminal — or ask Kratos to — then look again.
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-fg-faint">
                Anything listening on <span className="font-mono">localhost</span> or{" "}
                <span className="font-mono">0.0.0.0</span> on the Kratos host can be previewed; pick{" "}
                <em>Other port…</em> if it is not listed. Previews are served from port{" "}
                <span className="font-mono">{status.port}</span>, which this browser has to be able to
                reach the same way it reaches the portal.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
