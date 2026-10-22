import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LuChevronRight, LuDownload, LuFile, LuFolder } from "react-icons/lu";
import { api, downloadWorkspace, type FileEntry, type Session } from "../api";
import { Modal } from "./Modal";

/**
 * Pick parts of a session's workspace and take them home as a zip.
 *
 * Folders open as you expand them, so a workspace with a node_modules in it
 * costs one listing to show, not a walk of the lot. Ticking a folder takes
 * everything inside it, opened or not — the selection is kept as rules on the
 * paths you touched, and the server applies them as it walks.
 */

type Rules = Record<string, boolean>;

const DEFAULT_EXCLUDE = ".git, node_modules";

const parentOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

function selected(rules: Rules, rel: string): boolean {
  for (let p = rel; ; p = parentOf(p)) {
    if (p in rules) return rules[p];
    if (!p) return true;
  }
}

/** Something inside differs from the folder itself — draw it half-ticked. */
function mixed(rules: Rules, rel: string): boolean {
  const own = selected(rules, rel);
  const prefix = rel ? rel + "/" : "";
  return Object.entries(rules).some(([k, v]) => k !== rel && k.startsWith(prefix) && v !== own);
}

/** Keep in step with compilePatterns in server/src/api/files.ts. */
function compilePatterns(text: string): (rel: string) => boolean {
  const res = text
    .split(/[,\n]/)
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .map((p) => {
      const body = p
        .split("**")
        .map((part) =>
          part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"),
        )
        .join(".*");
      return { anchored: p.includes("/"), re: new RegExp(`^${body}$`) };
    });
  return (rel) => {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    return res.some(({ anchored, re }) => re.test(anchored ? rel : name));
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function Check({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked && !disabled}
      disabled={disabled}
      onChange={onChange}
      className="h-3.5 w-3.5 shrink-0 accent-accent"
    />
  );
}

export function DownloadDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [listings, setListings] = useState<Record<string, FileEntry[] | "loading" | { error: string }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [rules, setRules] = useState<Rules>({});
  const [patterns, setPatterns] = useState(DEFAULT_EXCLUDE);
  const [status, setStatus] = useState<{ kind: "started" | "error"; text: string } | null>(null);

  const excluded = useMemo(() => compilePatterns(patterns), [patterns]);

  const load = (rel: string) => {
    const current = listings[rel];
    if (current === "loading" || Array.isArray(current)) return;
    setListings((l) => ({ ...l, [rel]: "loading" }));
    api
      .sessionFiles(session.id, rel)
      .then((r) => setListings((l) => ({ ...l, [rel]: r.entries })))
      .catch((e: Error) => setListings((l) => ({ ...l, [rel]: { error: e.message } })));
  };

  useEffect(() => load(""), [session.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleOpen = (rel: string) => {
    const next = new Set(expanded);
    if (next.has(rel)) next.delete(rel);
    else {
      next.add(rel);
      load(rel);
    }
    setExpanded(next);
  };

  /** Sets a path and everything under it, dropping rules it now overrides. */
  const toggle = (rel: string) => {
    setStatus(null);
    setRules((r) => {
      const value = !selected(r, rel);
      const prefix = rel ? rel + "/" : "";
      const next: Rules = {};
      for (const [k, v] of Object.entries(r)) if (k !== rel && !k.startsWith(prefix)) next[k] = v;
      // Only recorded where it differs from what it would inherit, so the rules
      // stay a short description of what you changed.
      if (!rel || selected(next, parentOf(rel)) !== value) next[rel] = value;
      return next;
    });
  };

  const nothing = !selected(rules, "") && !Object.values(rules).some(Boolean);

  const start = () => {
    const exclude = patterns.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    setStatus({ kind: "started", text: "Preparing the zip — your browser will save it when it starts." });
    downloadWorkspace(session.id, { rules, exclude }, (text) => setStatus({ kind: "error", text }));
  };

  const renderDir = (dir: string, depth: number): ReactNode => {
    const listing = listings[dir];
    const pad = { paddingLeft: `${depth * 16 + 8}px` };
    if (!listing || listing === "loading") {
      return <div style={pad} className="py-1 text-xs text-fg-faint">Loading…</div>;
    }
    if ("error" in listing) {
      return <div style={pad} className="py-1 text-xs text-danger">{listing.error}</div>;
    }
    if (listing.length === 0) {
      return <div style={pad} className="py-1 text-xs text-fg-faint">Empty</div>;
    }
    return listing.map((e) => {
      const rel = join(dir, e.name);
      const skip = excluded(rel);
      const open = e.dir && expanded.has(rel);
      return (
        <div key={rel}>
          <div
            style={pad}
            className={`flex items-center gap-2 rounded-md py-1 pr-2 text-xs hover:bg-fg/5 ${skip ? "opacity-40" : ""}`}
            title={skip ? "Left out by an exclude pattern" : rel}
          >
            {e.dir ? (
              <button
                onClick={() => toggleOpen(rel)}
                aria-label={open ? `Collapse ${e.name}` : `Expand ${e.name}`}
                className="text-fg-subtle hover:text-fg"
              >
                <LuChevronRight className={`h-3.5 w-3.5 transition ${open ? "rotate-90" : ""}`} />
              </button>
            ) : (
              <span className="w-3.5" />
            )}
            <Check
              label={`Include ${rel}`}
              checked={selected(rules, rel)}
              indeterminate={e.dir && !skip && mixed(rules, rel)}
              disabled={skip}
              onChange={() => toggle(rel)}
            />
            {e.dir ? (
              <LuFolder className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
            ) : (
              <LuFile className="h-3.5 w-3.5 shrink-0 text-fg-faint" />
            )}
            <button
              onClick={() => (e.dir ? toggleOpen(rel) : !skip && toggle(rel))}
              className={`min-w-0 flex-1 truncate text-left text-fg ${skip ? "line-through" : ""}`}
            >
              {e.name}
            </button>
            {!e.dir && <span className="shrink-0 font-mono text-[11px] text-fg-faint">{formatSize(e.size)}</span>}
          </div>
          {open && !skip && renderDir(rel, depth + 1)}
        </div>
      );
    });
  };

  return (
    <Modal
      title="Download files"
      subtitle={session.workspace}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-3">
          <p
            className={`min-w-0 flex-1 text-xs ${status?.kind === "error" ? "text-danger" : "text-fg-subtle"}`}
            role="status"
          >
            {status?.text ?? (nothing ? "Nothing selected" : "Selected files are zipped as they download.")}
          </p>
          <button
            onClick={start}
            disabled={nothing}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-40"
          >
            <LuDownload className="h-3.5 w-3.5" />
            Download .zip
          </button>
        </div>
      }
    >
      <label className="block text-xs text-fg-muted">
        Exclude
        <input
          value={patterns}
          onChange={(e) => {
            setPatterns(e.target.value);
            setStatus(null);
          }}
          placeholder=".git, node_modules, *.log"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-line bg-canvas px-3 py-1.5 font-mono text-xs text-fg outline-none focus:border-accent/60"
        />
        <span className="mt-1 block text-[11px] text-fg-faint">
          Comma-separated. A name matches at any depth; a pattern with a slash matches from the workspace root.
        </span>
      </label>

      <div className="mt-4 flex items-center gap-2 border-b border-line px-2 pb-2 text-xs">
        <Check
          label="Select everything"
          checked={selected(rules, "")}
          indeterminate={mixed(rules, "")}
          onChange={() => toggle("")}
        />
        <span className="text-fg-muted">Everything</span>
      </div>
      <div className="mt-1 max-h-[50vh] overflow-y-auto">{renderDir("", 0)}</div>
    </Modal>
  );
}
