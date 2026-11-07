import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import express, { type Router } from "express";
import { AUTH_COOKIE, isAuthedHeader, parseCookies } from "./auth.js";

/**
 * Previews of the apps being built here.
 *
 * A dev server started in a workspace listens on this machine's loopback, which
 * the person reading the portal usually cannot reach — and if they could, an
 * HTTPS portal would refuse to frame a plain-HTTP port. So the portal forwards
 * to it.
 *
 * On its own port rather than under a path like /preview/5173/. Dev servers
 * write root-absolute URLs everywhere — /@vite/client, /_next/static, /src/... —
 * and under a prefix every one of those lands on the portal instead of the app.
 * At the root of its own origin the app sees the paths it expects, HMR
 * websockets included.
 *
 * Which app a request goes to is a cookie, set by the entry URL the panel
 * frames. Cookies ignore ports, so the portal's login cookie arrives here too
 * and gates it: this reaches nothing the terminal beside it cannot.
 */

const PORTAL_PORT = Number(process.env.PORT || 4100);
const RAW = process.env.PREVIEW_PORT?.trim();
/** "0" or "off" turns previews off; empty means the port after the portal's. */
const PREVIEW_PORT = RAW === "0" || RAW === "off" ? null : Number(RAW || PORTAL_PORT + 1);

const TARGET_COOKIE = "kratos_preview_port";
const ENTRY = "/__kratos_preview/open";
/** Resolves to both families; Node tries each, so ::1-only servers are found too. */
const UPSTREAM_HOST = "localhost";

let listening: { port: number; secure: boolean } | null = null;
let failure: string | null = PREVIEW_PORT === null ? "Previews are turned off (PREVIEW_PORT=0)." : null;

function validPort(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // Framing either of these is a loop, not a preview.
  if (n === PREVIEW_PORT || n === PORTAL_PORT) return null;
  return n;
}

/** Only a path on this origin — "//evil.example" is a URL, not a path. */
function safePath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  return value;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "[::]"]);

/** A redirect to http://localhost:5173/x is a redirect to /x from where the browser stands. */
function fromUpstream(location: string): string {
  try {
    const u = new URL(location);
    if (LOOPBACK_NAMES.has(u.hostname)) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    // Relative already.
  }
  return location;
}

function stripCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((c) => c.trim())
    .filter((c) => {
      const name = c.split("=", 1)[0];
      return c && name !== AUTH_COOKIE && name !== TARGET_COOKIE;
    });
  return kept.length ? kept.join("; ") : undefined;
}

/**
 * What the dev server is told. It is told it was reached as localhost: Vite and
 * others reject unfamiliar Host and Origin headers, and the person running it
 * should not have to allowlist the portal's hostname to see their own app.
 */
function forwardHeaders(headers: http.IncomingHttpHeaders, port: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers, host: `localhost:${port}` };
  if (out.origin) out.origin = `http://localhost:${port}`;
  if (typeof out.referer === "string") {
    try {
      const u = new URL(out.referer);
      out.referer = `http://localhost:${port}${u.pathname}${u.search}`;
    } catch {
      delete out.referer;
    }
  }
  const cookie = stripCookies(headers.cookie);
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  return out;
}

/** What the browser is told: everything, minus whatever would stop it being framed. */
function returnHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  delete out["x-frame-options"];
  const csp = out["content-security-policy"];
  if (typeof csp === "string") {
    const kept = csp
      .split(";")
      .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
      .join(";");
    if (kept.trim()) out["content-security-policy"] = kept;
    else delete out["content-security-policy"];
  }
  if (typeof out.location === "string") out.location = fromUpstream(out.location);
  // A cookie scoped to Domain=localhost is dropped by a browser that is not on localhost.
  if (Array.isArray(out["set-cookie"])) {
    out["set-cookie"] = out["set-cookie"].map((c) => c.replace(/;\s*domain=[^;]*/i, ""));
  }
  return out;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Shown inside the frame, so it says what to do rather than just a status. */
function notice(res: http.ServerResponse, status: number, title: string, detail: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px/1.5 system-ui, sans-serif; color: #6b7280; background: Canvas; }
  main { max-width: 28rem; padding: 1.5rem; text-align: center; }
  h1 { font-size: 15px; font-weight: 600; color: CanvasText; margin: 0 0 .35rem; }
  code { font-size: 12px; }
</style>
<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main>`);
}

function targetOf(req: http.IncomingMessage): number | null {
  return validPort(parseCookies(req.headers.cookie).get(TARGET_COOKIE));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!isAuthedHeader(req.headers.cookie)) {
    return notice(res, 401, "Sign in to Kratos first", "Previews use the portal's login. Open the portal, sign in, and reload this.");
  }

  const url = new URL(req.url ?? "/", "http://preview");
  if (url.pathname === ENTRY) {
    const port = validPort(url.searchParams.get("port"));
    if (!port) return notice(res, 400, "Not a port that can be previewed", String(url.searchParams.get("port")));
    res.writeHead(302, {
      location: safePath(url.searchParams.get("path")),
      "set-cookie": `${TARGET_COOKIE}=${port}; Path=/; HttpOnly; SameSite=Lax`,
      "cache-control": "no-store",
    });
    return void res.end();
  }

  const port = targetOf(req);
  if (!port) {
    return notice(res, 409, "No app selected", "Pick an app in the Preview panel beside a Kratos session.");
  }

  const upstream = http.request(
    { host: UPSTREAM_HOST, port, path: req.url, method: req.method, headers: forwardHeaders(req.headers, port) },
    (up) => {
      res.writeHead(up.statusCode ?? 502, returnHeaders(up.headers));
      up.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    if (res.headersSent) return void res.destroy();
    notice(
      res,
      502,
      `Nothing is answering on port ${port}`,
      `Is the dev server still running? It must listen on localhost or 0.0.0.0 on the Kratos host. (${e.message})`
    );
  });
  req.pipe(upstream);
}

/** The HMR half: Vite, Next and the rest push reloads over a websocket. */
function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const refuse = (line: string) => socket.end(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`);
  if (!isAuthedHeader(req.headers.cookie)) return refuse("401 Unauthorized");
  const port = targetOf(req);
  if (!port) return refuse("409 Conflict");

  const proxied = http.request({
    host: UPSTREAM_HOST,
    port,
    path: req.url,
    method: req.method,
    headers: forwardHeaders(req.headers, port),
  });

  proxied.on("upgrade", (up, upSocket, upHead) => {
    const lines = Object.entries(up.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : [`${k}: ${v}`]
    );
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    // Bytes either side sent ahead of the pipe, delivered in the direction they were going.
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    const close = () => {
      upSocket.destroy();
      socket.destroy();
    };
    for (const s of [socket, upSocket]) {
      s.on("close", close);
      s.on("error", close);
    }
  });
  // The dev server answered without upgrading — pass its verdict on.
  proxied.on("response", (r) => {
    refuse(`${r.statusCode} ${r.statusMessage ?? ""}`);
    r.resume();
  });
  proxied.on("error", () => socket.destroy());
  proxied.end();
}

/**
 * Start the preview listener, with the portal's certificate when it has one —
 * an HTTPS page will not frame an HTTP one.
 */
export function startPreviewServer(tls: { cert: Buffer; key: Buffer } | null): void {
  if (PREVIEW_PORT === null) return;
  if (!Number.isInteger(PREVIEW_PORT) || PREVIEW_PORT < 1 || PREVIEW_PORT > 65535) {
    failure = `PREVIEW_PORT is not a port: ${RAW}`;
    console.error(`[preview] ${failure}`);
    return;
  }
  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.on("upgrade", upgrade);
  server.on("error", (e) => {
    listening = null;
    failure = `Could not listen on ${PREVIEW_PORT}: ${e.message}`;
    console.error(`[preview] ${failure}`);
  });
  server.listen(PREVIEW_PORT, "0.0.0.0", () => {
    listening = { port: PREVIEW_PORT, secure: !!tls };
    failure = null;
    console.log(`  previews: :${PREVIEW_PORT}${tls ? " (https)" : ""}`);
  });
}

// --- finding what is running ---

/**
 * Addresses a server can be bound to and still be reached over loopback:
 * 0.0.0.0, 127.0.0.1, ::, ::1 and ::ffff:127.0.0.1, as /proc/net spells them.
 */
const REACHABLE = new Set([
  "00000000",
  "0100007F",
  "00000000000000000000000000000000",
  "00000000000000000000000001000000",
  "0000000000000000FFFF00000100007F",
]);
const LISTEN = "0A";

/**
 * Listening TCP ports, from the kernel's own table. Linux only — elsewhere it
 * returns nothing and a port is typed by hand. With host networking the
 * container sees the host's sockets, so servers started outside Kratos show up
 * too.
 */
export function listeningPorts(): number[] {
  const ports = new Set<number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols[3] !== LISTEN || !cols[1]) continue;
      const [addr, portHex] = cols[1].split(":");
      if (!REACHABLE.has(addr)) continue;
      const port = validPort(parseInt(portHex, 16));
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export interface PreviewServer {
  port: number;
  status: number;
  /** The page's <title>, which is usually enough to tell two dev servers apart. */
  title: string | null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
const titleOf = (html: string) => {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1].replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ENTITIES[e]).trim();
  return t || null;
};

/** Whether a port speaks HTTP — a database or an SSH tunnel is not an app to preview. */
function probe(port: number): Promise<PreviewServer | null> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: UPSTREAM_HOST, port, path: "/", headers: { host: `localhost:${port}`, accept: "text/html" }, timeout: 1500 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 64 * 1024) res.destroy();
        });
        const done = () => resolve({ port, status: res.statusCode ?? 0, title: titleOf(body) });
        res.on("end", done);
        res.on("close", done);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

export async function discover(): Promise<PreviewServer[]> {
  const found = await Promise.all(listeningPorts().slice(0, 64).map(probe));
  return found.filter((s): s is PreviewServer => s !== null);
}

export function previewRouter(): Router {
  const router = express.Router();
  router.get("/preview", async (_req, res) => {
    res.json({
      port: listening?.port ?? null,
      secure: listening?.secure ?? false,
      error: failure,
      servers: await discover(),
    });
  });
  return router;
}
