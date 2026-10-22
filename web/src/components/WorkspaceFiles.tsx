import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  LuChevronRight,
  LuFile,
  LuFolder,
  LuFolderPlus,
  LuFolderUp,
  LuHouse,
  LuRefreshCw,
  LuUpload,
  LuX,
} from "react-icons/lu";
import { api, uploadFile, type FileEntry } from "../api";
import { FileViewer } from "./FileViewer";

/**
 * A session's workspace, folder by folder, with a way to put files into it
 * and to open any file to read it.
 *
 * Whatever folder is open is where an import lands — pick the folder first,
 * then drop files on it, use the buttons, or drop a whole folder and its
 * structure is recreated underneath. Uploads go one at a time: the bottleneck
 * is the network, and serial keeps the progress honest and a failure local.
 */

interface Upload {
  key: string;
  dir: string;
  /** Relative to `dir`, and may include subfolders. */
  name: string;
  file: File;
  loaded: number;
  state: "queued" | "uploading" | "done" | "error" | "exists";
  error?: string;
}

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function formatSize(bytes: number): string {
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

function ago(ms?: number): string {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 43200) return `${Math.round(mins / 1440)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Everything inside a dropped folder, with paths relative to where it was dropped. */
async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<{ name: string; file: File }[]> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ name: join(prefix, entry.name), file }];
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries hands back a page at a time and an empty page at the end.
  for (;;) {
    const page = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!page.length) break;
    children.push(...page);
  }
  const nested = await Promise.all(children.map((c) => walkEntry(c, join(prefix, entry.name))));
  return nested.flat();
}

export function WorkspaceFiles({
  sessionId,
  workspace,
  className = "",
}: {
  sessionId: string;
  workspace: string;
  className?: string;
}) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  /** The file open in the viewer, in place of the folder listing. */
  const [opened, setOpened] = useState<{ path: string; size: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);
  const queue = useRef<Upload[]>([]);
  const dirRef = useRef(dir);
  dirRef.current = dir;

  const load = useCallback(
    async (path: string) => {
      setError(null);
      try {
        const r = await api.sessionFiles(sessionId, path);
        if (dirRef.current === path) setEntries(r.entries);
      } catch (e) {
        if (dirRef.current === path) {
          setEntries([]);
          setError((e as Error).message);
        }
      }
    },
    [sessionId],
  );

  useEffect(() => {
    setEntries(null);
    setOpened(null);
    void load(dir);
  }, [dir, load]);

  // A different session is a different tree; start from its top.
  useEffect(() => {
    setDir("");
    setOpened(null);
    setUploads([]);
    queue.current = [];
  }, [sessionId]);

  const patch = (key: string, p: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...p } : u)));

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (let next = queue.current.shift(); next; next = queue.current.shift()) {
        const u = next;
        patch(u.key, { state: "uploading", loaded: 0, error: undefined });
        try {
          await uploadFile(sessionId, u.dir, u.name, u.file, {
            overwrite: u.state === "exists",
            onProgress: (loaded) => patch(u.key, { loaded }),
          });
          patch(u.key, { state: "done", loaded: u.file.size });
        } catch (e) {
          const err = e as Error & { exists?: boolean };
          patch(u.key, { state: err.exists ? "exists" : "error", error: err.message });
        }
        // Show it the moment it lands if it landed in the folder on screen.
        const top = u.name.includes("/") ? join(u.dir, u.name.split("/")[0]) : join(u.dir, u.name);
        if (u.dir === dirRef.current || top.startsWith(dirRef.current)) void load(dirRef.current);
      }
    } finally {
      running.current = false;
    }
  }, [sessionId, load]);

  const enqueue = (files: { name: string; file: File }[]) => {
    if (!files.length) return;
    const stamp = Date.now();
    const items: Upload[] = files.map((f, i) => ({
      key: `${stamp}-${i}-${f.name}`,
      dir,
      name: f.name,
      file: f.file,
      loaded: 0,
      state: "queued",
    }));
    queue.current.push(...items);
    setUploads((list) => [...list.filter((u) => u.state !== "done"), ...items]);
    void pump();
  };

  const replace = (u: Upload) => {
    // "exists" is what tells pump to send overwrite=1.
    queue.current.push({ ...u, state: "exists" });
    patch(u.key, { state: "queued", error: undefined });
    void pump();
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const items = [...e.dataTransfer.items];
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((x): x is FileSystemEntry => Boolean(x));
    try {
      if (entries.length) {
        enqueue((await Promise.all(entries.map((en) => walkEntry(en, "")))).flat());
      } else {
        enqueue([...e.dataTransfer.files].map((file) => ({ name: file.name, file })));
      }
    } catch (err) {
      setError(`Could not read what was dropped: ${(err as Error).message}`);
    }
  };

  const createFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name) return setNewFolder(null);
    try {
      await api.createFolder(sessionId, join(dir, name));
      setNewFolder(null);
      void load(dir);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const crumbs = dir ? dir.split("/") : [];
  const active = uploads.filter((u) => u.state === "queued" || u.state === "uploading").length;
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;

  return (
    <div className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <nav aria-label="Folder" className="flex min-w-0 flex-1 items-center gap-0.5 text-xs">
          <button
            onClick={() => setDir("")}
            className="flex items-center gap-1 rounded px-1.5 py-1 text-fg-muted hover:bg-fg/5 hover:text-fg"
            title={workspace}
          >
            <LuHouse className="h-3.5 w-3.5" />
            <span className="max-w-[10rem] truncate">{workspaceName}</span>
          </button>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-0.5">
              <LuChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
              <button
                onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}
                className={`truncate rounded px-1.5 py-1 hover:bg-fg/5 ${i === crumbs.length - 1 ? "text-fg" : "text-fg-muted"}`}
              >
                {c}
              </button>
            </span>
          ))}
          {opened && (
            <span className="flex min-w-0 items-center gap-0.5">
              <LuChevronRight className="h-3 w-3 shrink-0 text-fg-faint" />
              <span className="truncate px-1.5 py-1 text-fg">{opened.path.slice(opened.path.lastIndexOf("/") + 1)}</span>
            </span>
          )}
        </nav>
        <div className="flex items-center gap-1">
          <ToolButton onClick={() => void load(dir)} label="Refresh">
            <LuRefreshCw className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton onClick={() => setNewFolder("")} label="New folder">
            <LuFolderPlus className="h-3.5 w-3.5" />
          </ToolButton>
          <ToolButton onClick={() => folderInput.current?.click()} label="Import a folder here">
            <LuFolderUp className="h-3.5 w-3.5" />
          </ToolButton>
          <button
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-1.5 rounded-lg bg-accent/12 px-2.5 py-1 text-xs text-accent ring-1 ring-inset ring-accent/25 hover:bg-accent/20"
          >
            <LuUpload className="h-3.5 w-3.5" /> Import files
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            enqueue([...(e.target.files ?? [])].map((file) => ({ name: file.name, file })));
            e.target.value = "";
          }}
        />
        <input
          ref={folderInput}
          type="file"
          hidden
          // Not in React's typings, but every current browser supports it.
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            enqueue(
              [...(e.target.files ?? [])].map((file) => ({ name: file.webkitRelativePath || file.name, file })),
            );
            e.target.value = "";
          }}
        />
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
        className={`relative min-h-[12rem] flex-1 rounded-xl border transition ${opened ? "overflow-hidden" : "overflow-y-auto"} ${
          dragging ? "border-dashed border-accent bg-accent/5" : "border-line bg-raised/30"
        }`}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center text-sm text-accent">
            Drop to import into /{dir}
          </div>
        )}
        {opened ? (
          <FileViewer
            sessionId={sessionId}
            path={opened.path}
            size={opened.size}
            onClose={() => setOpened(null)}
          />
        ) : (
        <>
        {error && <p className="border-b border-line px-3 py-2 text-xs text-danger">{error}</p>}
        <ul className={dragging ? "opacity-40" : ""}>
          {newFolder !== null && (
            <li className="flex items-center gap-2 border-b border-line px-3 py-1.5">
              <LuFolder className="h-4 w-4 shrink-0 text-accent" />
              <input
                autoFocus
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  // Escape here cancels the folder, not the dialog around it.
                  e.stopPropagation();
                  if (e.key === "Enter") void createFolder();
                  if (e.key === "Escape") setNewFolder(null);
                }}
                onBlur={() => void createFolder()}
                placeholder="Folder name"
                className="min-w-0 flex-1 rounded border border-accent/50 bg-canvas px-1.5 py-0.5 text-sm outline-none"
              />
            </li>
          )}
          {dir && (
            <li>
              <button
                onClick={() => setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-subtle hover:bg-fg/5"
              >
                <LuFolder className="h-4 w-4 shrink-0" /> ..
              </button>
            </li>
          )}
          {entries === null ? (
            <li className="px-3 py-6 text-center text-xs text-fg-subtle">Loading…</li>
          ) : entries.length === 0 && !error ? (
            <li className="px-3 py-8 text-center text-xs text-fg-subtle">
              Empty folder. Drop files here, or use Import files.
            </li>
          ) : (
            entries.map((e) => (
              <li key={e.name}>
                {e.dir ? (
                  <button
                    onClick={() => setDir(join(dir, e.name))}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-fg/5"
                  >
                    <LuFolder className="h-4 w-4 shrink-0 text-accent/80" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="shrink-0 text-[11px] text-fg-faint">{ago(e.mtime)}</span>
                  </button>
                ) : (
                  <button
                    onClick={() => setOpened({ path: join(dir, e.name), size: e.size })}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg-muted hover:bg-fg/5 hover:text-fg"
                  >
                    <LuFile className="h-4 w-4 shrink-0 text-fg-faint" />
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-fg-subtle">{formatSize(e.size)}</span>
                    <span className="w-16 shrink-0 text-right text-[11px] text-fg-faint">{ago(e.mtime)}</span>
                  </button>
                )}
              </li>
            ))
          )}
        </ul>
        </>
        )}
      </div>

      {uploads.length > 0 && (
        <div className="mt-2 rounded-xl border border-line bg-raised/30 p-2">
          <div className="mb-1 flex items-center gap-2 px-1 text-[11px] text-fg-subtle">
            <span>
              {active ? `Importing ${active} file${active === 1 ? "" : "s"}…` : "Imports"}
            </span>
            {!active && (
              <button onClick={() => setUploads([])} className="ml-auto hover:text-fg" title="Clear">
                <LuX className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {uploads.map((u) => (
              <li key={u.key} className="rounded-lg px-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted" title={join(u.dir, u.name)}>
                    /{join(u.dir, u.name)}
                  </span>
                  {u.state === "exists" ? (
                    <button onClick={() => replace(u)} className="shrink-0 text-warn hover:underline">
                      exists — replace
                    </button>
                  ) : (
                    <span
                      className={`shrink-0 ${
                        u.state === "error" ? "text-danger" : u.state === "done" ? "text-ok" : "text-fg-subtle"
                      }`}
                      title={u.error}
                    >
                      {u.state === "uploading"
                        ? `${Math.round((u.loaded / Math.max(u.file.size, 1)) * 100)}%`
                        : u.state === "error"
                          ? u.error ?? "failed"
                          : u.state === "done"
                            ? formatSize(u.file.size)
                            : "waiting"}
                    </span>
                  )}
                </div>
                {u.state === "uploading" && (
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-fg/10">
                    <div
                      className="h-full rounded-full bg-accent transition-[width]"
                      style={{ width: `${(u.loaded / Math.max(u.file.size, 1)) * 100}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ToolButton({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-lg border border-line p-1.5 text-fg-muted transition hover:bg-fg/5 hover:text-fg"
    >
      {children}
    </button>
  );
}
