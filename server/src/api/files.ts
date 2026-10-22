import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { type Request, type Router } from "express";
import yazl from "yazl";
import { getSession } from "../db.js";

/**
 * Taking a session's workspace home as a zip.
 *
 * Selection is sent as rules rather than a list of files: `{ "": true,
 * "node_modules": false, "node_modules/keep-me": true }`. A path takes the
 * value of its nearest ruled ancestor, so ticking a folder takes everything in
 * it without the browser having to have opened it first, and a workspace with
 * a hundred thousand files costs a request of a few lines. Patterns ride on
 * top — `.git`, `*.log` — for the things you never want, wherever they are.
 *
 * Streamed straight to the response: nothing is staged on disk or held in
 * memory, so a large workspace is limited by the network and not the portal.
 *
 * Symlinks are skipped, both in the listing and the archive. Following one
 * could read outside the workspace, and the agent can make them.
 */

type Rules = Record<string, boolean>;

/** Formats that are already compressed — deflating them again only costs CPU. */
const STORED = new Set([
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".7z", ".rar",
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".heic",
  ".mp3", ".mp4", ".m4a", ".mov", ".mkv", ".webm", ".ogg", ".opus", ".flac",
  ".woff", ".woff2", ".pdf", ".docx", ".xlsx", ".pptx", ".jar", ".whl", ".gguf",
]);

/** A workspace-relative path in posix form, or null if it would escape. */
function cleanRel(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.includes("\0") || raw.includes("\\")) return null;
  const norm = path.posix.normalize(raw).replace(/^\/+|\/+$/g, "");
  if (norm === "." || norm === "") return "";
  if (norm === ".." || norm.startsWith("../")) return null;
  return norm;
}

function absolute(root: string, rel: string): string {
  return rel ? path.join(root, ...rel.split("/")) : root;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

/** Whether `rel` is selected, by its nearest ruled ancestor. Everything, by default. */
function selected(rules: Rules, rel: string): boolean {
  for (let p = rel; ; p = parentOf(p)) {
    if (p in rules) return rules[p];
    if (!p) return true;
  }
}

/** Whether anything inside an unselected folder was picked out individually. */
function selectedBelow(rules: Rules, rel: string): boolean {
  const prefix = rel ? rel + "/" : "";
  return Object.entries(rules).some(([k, v]) => v && k.startsWith(prefix) && k !== rel);
}

/**
 * Shell-style patterns. One without a slash matches a name at any depth
 * (`node_modules`, `*.log`); one with a slash matches from the workspace root
 * (`build/cache`, `docs/**`). Keep in step with the copy in DownloadDialog.
 */
export function compilePatterns(patterns: string[]): (rel: string) => boolean {
  const res = patterns
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

interface Entry {
  rel: string;
  dir: boolean;
}

/** Every file to archive, plus folders that would otherwise vanish for being empty. */
async function collect(root: string, rules: Rules, excluded: (rel: string) => boolean): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (rel: string): Promise<number> => {
    const dirents = await readdir(absolute(root, rel), { withFileTypes: true }).catch(() => []);
    let taken = 0;
    for (const d of dirents) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      if (excluded(child)) continue;
      if (d.isDirectory()) {
        const on = selected(rules, child);
        if (!on && !selectedBelow(rules, child)) continue;
        const before = out.length;
        const n = await walk(child);
        if (n === 0 && on) out.splice(before, 0, { rel: child, dir: true });
        taken += n || (on ? 1 : 0);
      } else if (d.isFile() && selected(rules, child)) {
        out.push({ rel: child, dir: false });
        taken++;
      }
    }
    return taken;
  };
  await walk("");
  return out;
}

/** The form post carries its JSON in one field; a fetch sends it as the body. */
function readSpec(req: Request): { rules: Rules; exclude: string[] } | null {
  let body: unknown = req.body;
  if (typeof (body as { spec?: unknown })?.spec === "string") {
    try {
      body = JSON.parse((body as { spec: string }).spec);
    } catch {
      return null;
    }
  }
  const b = (body ?? {}) as { rules?: unknown; exclude?: unknown };
  const rules: Rules = {};
  if (b.rules && typeof b.rules === "object") {
    for (const [k, v] of Object.entries(b.rules)) {
      const rel = cleanRel(k);
      if (rel === null || typeof v !== "boolean") return null;
      rules[rel] = v;
    }
  }
  const exclude = Array.isArray(b.exclude) ? b.exclude.filter((p): p is string => typeof p === "string") : [];
  return { rules, exclude };
}

/** Per file. Generous, since models and datasets are what people bring. */
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 4 * 1024 ** 3;

const formatLimit = () => `${Math.round(UPLOAD_MAX_BYTES / 1024 ** 2)} MB`;

/**
 * Refuse a folder that resolves outside the workspace.
 *
 * The path itself was already cleaned of `..`; this is about symlinks. The
 * agent can make them, and one pointing at / would turn an upload into a write
 * anywhere. Checked on the nearest folder that exists, since the rest is about
 * to be created and cannot be a link yet.
 */
async function assertInside(workspace: string, dir: string): Promise<void> {
  const root = await realpath(workspace);
  let probe = dir;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error("That folder is outside the workspace");
      if (!(await stat(real)).isDirectory()) throw new Error("Part of that path is a file, not a folder");
      return;
    }
    const up = path.dirname(probe);
    if (up === probe) throw new Error("Workspace not found");
    probe = up;
  }
}

/**
 * What a file is served as when opened in the browser. Only media the viewer
 * shows natively is typed; everything else goes out as plain text, so an HTML
 * file the agent wrote shows its source rather than running on our origin.
 */
const MEDIA: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".opus": "audio/ogg", ".flac": "audio/flac",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf",
};

function archiveName(workspace: string): string {
  const base = path.basename(workspace).replace(/[^\w.-]+/g, "-") || "workspace";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${base}-${stamp}.zip`;
}

export function filesRouter(): Router {
  const router = express.Router();

  /** One folder of a session's workspace — the dialog opens folders as you expand them. */
  router.get("/sessions/:id/files", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const rel = cleanRel(req.query.path ?? "");
    if (rel === null) return res.status(400).json({ error: "Invalid path" });

    const dir = absolute(session.workspace, rel);
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      return res.status(404).json({ error: (e as Error).message });
    }
    const entries = await Promise.all(
      dirents
        .filter((d) => d.isDirectory() || d.isFile())
        .map(async (d) => {
          const s = await stat(path.join(dir, d.name)).catch(() => null);
          return {
            name: d.name,
            dir: d.isDirectory(),
            size: d.isFile() ? s?.size ?? 0 : 0,
            mtime: s?.mtimeMs ?? 0,
          };
        }),
    );
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    res.json({ path: rel, entries });
  });

  /**
   * One file of the workspace, to view or (with `download=1`) to save.
   *
   * Range requests are honoured, so the viewer can read the head of a large
   * log without pulling all of it and video can seek. Opened directly, the
   * page is sandboxed: an SVG is the one served type that can carry script.
   * PDFs are spared, since the browser's viewer will not run in a sandbox.
   */
  router.get("/sessions/:id/file", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const rel = cleanRel(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "Invalid path" });
    const target = absolute(session.workspace, rel);

    try {
      await assertInside(session.workspace, path.dirname(target));
    } catch (e) {
      return res.status(404).json({ error: (e as Error).message });
    }
    const s = await lstat(target).catch(() => null);
    if (!s || s.isSymbolicLink() || !s.isFile()) return res.status(404).json({ error: "Not a file" });

    const name = path.basename(rel);
    const download = req.query.download === "1";
    const type = download
      ? "application/octet-stream"
      : MEDIA[path.extname(name).toLowerCase()] ?? "text/plain; charset=utf-8";
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${name.replace(/[^\w.-]+/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    };
    if (type !== "application/pdf") headers["Content-Security-Policy"] = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'";

    res.sendFile(target, { dotfiles: "allow", headers, lastModified: false, etag: false }, (e) => {
      if (e && !res.headersSent) res.status(404).json({ error: e.message });
    });
  });

  /**
   * One file into a folder of the workspace, as the raw request body.
   *
   * Raw rather than multipart so nothing needs parsing and nothing is held in
   * memory: the body is piped to a temporary file beside the target and renamed
   * into place once complete, so an interrupted upload never leaves a truncated
   * file where the agent would read it. `name` may carry subfolders — a folder
   * dropped in the browser arrives one file at a time with its relative path.
   */
  router.post("/sessions/:id/upload", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const dir = cleanRel(req.query.path ?? "");
    const name = cleanRel(req.query.name ?? "");
    if (dir === null || !name) return res.status(400).json({ error: "Invalid path or file name" });
    const rel = dir ? `${dir}/${name}` : name;
    if (rel.split("/").some((part) => part === ".." || part === ".")) {
      return res.status(400).json({ error: "Invalid path" });
    }
    const target = absolute(session.workspace, rel);

    try {
      await assertInside(session.workspace, path.dirname(target));
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    const existing = await lstat(target).catch(() => null);
    if (existing?.isDirectory()) return res.status(409).json({ error: `"${rel}" is a folder` });
    if (existing?.isSymbolicLink()) return res.status(409).json({ error: `"${rel}" is a symlink` });
    if (existing && req.query.overwrite !== "1") {
      return res.status(409).json({ error: `"${rel}" already exists`, exists: true });
    }

    // A body some parser already consumed — a .json file sent with its own
    // content type, say — would arrive here empty and save as a blank file.
    if (req.readableEnded) {
      return res.status(415).json({ error: "Send the file as application/octet-stream" });
    }
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: `Larger than the ${formatLimit()} upload limit` });
    }

    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.kratos-upload-${process.pid}-${Date.now()}`;
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        received += chunk.length;
        if (received > UPLOAD_MAX_BYTES) done(new Error(`Larger than the ${formatLimit()} upload limit`));
        else done(null, chunk);
      },
    });
    try {
      await pipeline(req, limiter, createWriteStream(temp, { flags: "wx" }));
      await rename(temp, target);
    } catch (e) {
      await unlink(temp).catch(() => {});
      if (res.headersSent || req.destroyed) return;
      const tooBig = received > UPLOAD_MAX_BYTES;
      return res.status(tooBig ? 413 : 500).json({ error: (e as Error).message });
    }
    res.json({ ok: true, path: rel, size: received });
  });

  /** An empty folder to upload into. */
  router.post("/sessions/:id/folders", async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Not found" });
    const rel = cleanRel(req.body?.path);
    if (!rel) return res.status(400).json({ error: "Invalid folder name" });
    const target = absolute(session.workspace, rel);
    try {
      await assertInside(session.workspace, path.dirname(target));
      if (await lstat(target).catch(() => null)) return res.status(409).json({ error: `"${rel}" already exists` });
      await mkdir(target, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: (e as Error).message });
    }
    res.json({ ok: true, path: rel });
  });

  router.post(
    "/sessions/:id/download",
    express.urlencoded({ extended: false, limit: "2mb" }),
    async (req, res) => {
      const session = getSession(req.params.id);
      if (!session) return res.status(404).json({ error: "Not found" });
      const spec = readSpec(req);
      if (!spec) return res.status(400).json({ error: "Invalid selection" });

      const root = session.workspace;
      const entries = await collect(root, spec.rules, compilePatterns(spec.exclude));
      if (entries.length === 0) return res.status(400).json({ error: "Nothing selected to download" });

      const name = archiveName(root);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );

      const zip = new yazl.ZipFile();
      // Headers are gone by now, so a failure can only cut the download short —
      // which the browser reports as failed, rather than saving a broken zip
      // that looks complete.
      zip.on("error", (e: Error) => {
        console.error(`[download] ${session.id}: ${e.message}`);
        res.destroy(e);
      });
      res.on("close", () => {
        if (!res.writableFinished) zip.outputStream.unpipe(res);
      });
      zip.outputStream.pipe(res);

      for (const e of entries) {
        if (e.dir) zip.addEmptyDirectory(e.rel);
        else zip.addFile(absolute(root, e.rel), e.rel, { compress: !STORED.has(path.extname(e.rel).toLowerCase()) });
      }
      zip.end();
    },
  );

  return router;
}
