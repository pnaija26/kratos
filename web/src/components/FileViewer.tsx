import { useEffect, useState } from "react";
import { LuArrowLeft, LuDownload, LuExternalLink } from "react-icons/lu";
import { fileUrl } from "../api";
import { formatSize } from "./WorkspaceFiles";

/**
 * One file of a workspace, shown as well as the browser can.
 *
 * Media the browser plays itself is pointed at the file's URL; everything
 * else is read as text. Only the head of a large file is fetched — the viewer
 * is for looking, and a multi-gigabyte log should not stall the tab. A file
 * with NUL bytes near the start is taken to be binary and offered as a
 * download instead of shown as noise.
 */

const TEXT_LIMIT = 512 * 1024;

type Kind = "image" | "video" | "audio" | "pdf" | "text";

const KINDS: Record<string, Kind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image",
  bmp: "image", ico: "image", svg: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", opus: "audio", flac: "audio",
  pdf: "pdf",
};

function kindOf(name: string): Kind {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && KINDS[name.slice(dot + 1).toLowerCase()]) || "text";
}

type Text =
  | { state: "loading" }
  | { state: "ok"; text: string; truncated: boolean }
  | { state: "binary" }
  | { state: "error"; message: string };

export function FileViewer({
  sessionId,
  path,
  size,
  onClose,
}: {
  sessionId: string;
  path: string;
  size: number;
  onClose: () => void;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const kind = kindOf(name);
  const url = fileUrl(sessionId, path);
  const [text, setText] = useState<Text>({ state: "loading" });

  useEffect(() => {
    if (kind !== "text") return;
    if (size === 0) return setText({ state: "ok", text: "", truncated: false });
    setText({ state: "loading" });
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: ctrl.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.subarray(0, 8000).includes(0)) return setText({ state: "binary" });
        setText({
          state: "ok",
          text: new TextDecoder("utf-8").decode(bytes),
          truncated: size > bytes.length,
        });
      } catch (e) {
        if (!ctrl.signal.aborted) setText({ state: "error", message: (e as Error).message });
      }
    })();
    return () => ctrl.abort();
  }, [url, kind, size]);

  const download = (
    <a
      href={fileUrl(sessionId, path, { download: true })}
      className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-fg-muted transition hover:bg-fg/5 hover:text-fg"
    >
      <LuDownload className="h-3.5 w-3.5" /> Download
    </a>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <button
          onClick={onClose}
          title="Back to folder"
          aria-label="Back to folder"
          className="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg"
        >
          <LuArrowLeft className="h-4 w-4" />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={path}>
          {name}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">{formatSize(size)}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title="Open in a new tab"
          aria-label="Open in a new tab"
          className="rounded p-1 text-fg-muted hover:bg-fg/5 hover:text-fg"
        >
          <LuExternalLink className="h-3.5 w-3.5" />
        </a>
        {download}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {kind === "image" && (
          <div className="grid min-h-full place-items-center p-4">
            <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
          </div>
        )}
        {kind === "video" && (
          <div className="grid min-h-full place-items-center p-4">
            <video src={url} controls className="max-h-full max-w-full" />
          </div>
        )}
        {kind === "audio" && (
          <div className="grid min-h-full place-items-center p-4">
            <audio src={url} controls className="w-full max-w-md" />
          </div>
        )}
        {kind === "pdf" && <iframe src={url} title={name} className="h-full w-full border-0" />}
        {kind === "text" &&
          (text.state === "loading" ? (
            <p className="px-3 py-6 text-center text-xs text-fg-subtle">Loading…</p>
          ) : text.state === "error" ? (
            <p className="px-3 py-2 text-xs text-danger">{text.message}</p>
          ) : text.state === "binary" ? (
            <div className="flex flex-col items-center gap-3 px-3 py-10 text-xs text-fg-subtle">
              <p>This looks like a binary file, so there is nothing readable to show.</p>
              {download}
            </div>
          ) : text.text === "" ? (
            <p className="px-3 py-8 text-center text-xs text-fg-subtle">Empty file.</p>
          ) : (
            <TextBody text={text.text} truncated={text.truncated} total={size} />
          ))}
      </div>
    </div>
  );
}

function TextBody({ text, truncated, total }: { text: string; truncated: boolean; total: number }) {
  // The last line of a cut-off file is probably partial; drop it rather than show half.
  const lines = text.split("\n");
  if (truncated && lines.length > 1) lines.pop();
  else if (lines[lines.length - 1] === "") lines.pop();
  const gutter = lines.map((_, i) => i + 1).join("\n");

  return (
    <>
      {truncated && (
        <p className="sticky left-0 top-0 z-10 border-b border-line bg-raised px-3 py-1.5 text-[11px] text-warn">
          Showing the first {formatSize(TEXT_LIMIT)} of {formatSize(total)}. Download it to see the rest.
        </p>
      )}
      <div className="flex min-w-max font-mono text-xs leading-5">
        <pre
          aria-hidden
          className="sticky left-0 select-none border-r border-line bg-raised/60 px-2 py-2 text-right text-fg-faint"
        >
          {gutter}
        </pre>
        <pre className="px-3 py-2 text-fg">{lines.join("\n")}</pre>
      </div>
    </>
  );
}
