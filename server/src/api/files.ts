import { readdir, stat } from "node:fs/promises";
import path from "node:path";
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
        .map(async (d) => ({
          name: d.name,
          dir: d.isDirectory(),
          size: d.isFile() ? await stat(path.join(dir, d.name)).then((s) => s.size, () => 0) : 0,
        })),
    );
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    res.json({ path: rel, entries });
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
