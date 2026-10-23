// kimo-alexa: a self-hosted MCP server (protocol 2025-11-25, Streamable HTTP) that gives
// Alexa+ a handful of voice-sized video-editing tools. Every tool is carried out by kimo,
// an open-source Rust video engine, which runs as a child MCP server over stdio.
//
//   Alexa+ / any MCP client --(Streamable HTTP, POST /mcp, SSE)--> kimo-alexa --(stdio MCP)--> kimo-mcp
//
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { KimoSession } from "./kimo.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const FOOTAGE = process.env.FOOTAGE_DIR || path.join(ROOT, "footage/trip");
const DATA = process.env.DATA_DIR || path.join(ROOT, "data");
const PROTOCOL = "2025-11-25";
fs.mkdirSync(path.join(DATA, "projects"), { recursive: true });
fs.mkdirSync(path.join(DATA, "renders"), { recursive: true });

// ---------------------------------------------------------------- projects
// A project lives as long as the server: the kimo child keeps the timeline in memory and
// every edit is also saved to data/projects/<id>.kimo, so "make it shorter" edits the same reel.
const projects = new Map();
let lastProjectId = null;
const tv = { playing: null, title: null, since: null }; // the simulated "TV" (Fire TV / Echo Show) screen

const LOOKS = {
  warm:    { gain: [1.10, 1.02, 0.88, 1], lift: [0.02, 0.0, -0.02, 0], saturation: 1.18, contrast: 1.05 },
  cool:    { gain: [0.92, 1.0, 1.10, 1], lift: [-0.01, 0, 0.02, 0], saturation: 1.05, contrast: 1.05 },
  vivid:   { gain: [1.03, 1.03, 1.03, 1], saturation: 1.40, contrast: 1.12 },
  vintage: { gain: [1.06, 1.0, 0.86, 1], lift: [0.05, 0.04, 0.02, 0], saturation: 0.80, contrast: 0.92 },
  mono:    { saturation: 0.0, contrast: 1.15 },
  natural: { saturation: 1.0, contrast: 1.0 },
};
const MOODS = { upbeat: "dip_white", calm: "crossfade", dreamy: "dissolve", energetic: "whip_left" };

function getProject(id) {
  const pid = id || lastProjectId;
  const p = projects.get(pid);
  if (!p) throw new Error(pid ? `No project '${pid}'. Make a reel first.` : "No reel yet. Ask me to make one first.");
  return p;
}
const prettyName = (f) => path.basename(f, path.extname(f)).replace(/^\d{4}-\d{2}-\d{2}_\d{4}_/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const fmt = (s) => { const ms = Math.round((s % 1) * 1000), t = Math.floor(s); return `${String(Math.floor(t / 3600)).padStart(2, "0")}:${String(Math.floor(t / 60) % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")},${String(ms).padStart(3, "0")}`; };

function probe(file) {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", file]).toString());
  const ct = out.format?.tags?.creation_time;
  return { duration: Number(out.format.duration), created: ct ? new Date(ct) : fs.statSync(file).mtime };
}

function resolveDate(when) {
  const w = String(when || "").trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const now = new Date();
  if (w === "today") return now.toISOString().slice(0, 10);
  if (w === "yesterday") return new Date(now - 864e5).toISOString().slice(0, 10);
  const i = days.findIndex((d) => w.includes(d));
  if (i >= 0) { // most recent such day (not today)
    let back = (now.getDay() - i + 7) % 7 || 7;
    return new Date(now - back * 864e5).toISOString().slice(0, 10);
  }
  return null;
}

// Lay clips back-to-back on the video track and rebuild captions for the current cut.
async function layout(p) {
  const k = p.kimo;
  let t = 0;
  for (const c of p.clips) {
    await k.call("timeline", "trim_clip", { clip_id: c.clip_id, duration: c.dur });
    await k.call("timeline", "move_clip", { clip_id: c.clip_id, start: t });
    c.start = t; t += c.dur;
  }
  p.duration = t;
}
async function writeCaptions(p) {
  const k = p.kimo;
  for (const id of p.captionClipIds || []) await k.call("timeline", "delete_clip", { clip_id: id });
  const srt = p.clips.map((c, i) => `${i + 1}\n${fmt(c.start + 0.4)} --> ${fmt(c.start + c.dur - 0.4)}\n${c.caption}\n`).join("\n");
  const srtPath = path.join(DATA, "projects", `${p.id}.srt`);
  fs.writeFileSync(srtPath, srt);
  const r = await k.call("text", "add_captions", { track_id: p.tracks.captions, source: "srt", path: srtPath, style: "subtitle", size: 28, y: 215, font: path.join(ROOT, "fonts/Inter-Var.ttf") });
  p.captionClipIds = r.clip_ids || [];
  return r;
}
async function save(p) {
  await p.kimo.call("project", "save_project", { path: path.join(DATA, "projects", `${p.id}.kimo`) });
  p.version += 1;
}
const summary = (p) => ({ project_id: p.id, duration_s: +p.duration.toFixed(2), clips: p.clips.length, look: p.look, title: p.title, captions: !!p.captionClipIds?.length, renders: p.renders.length, version: p.version });
const ok = (text, structured) => ({ content: [{ type: "text", text: JSON.stringify(structured ?? text) }], structuredContent: structured });

// ---------------------------------------------------------------- MCP server
function buildServer() {
  const server = new McpServer(
    { name: "kimo-alexa", version: "0.1.0", title: "kimo for Alexa+" },
    { instructions: "Voice-sized video editing. Typical flow: find_clips -> make_reel -> grade -> add_captions -> render -> play_on_tv. Follow-ups (shorten, add_title, grade) edit the same project; omit project_id to use the latest reel." }
  );

  server.registerTool("find_clips", {
    title: "Find clips",
    description: "Find the user's video clips shot on a day (e.g. 'saturday', 'yesterday', '2026-10-17'). Returns paths in shooting order.",
    inputSchema: { when: z.string().describe("day: weekday name, 'today', 'yesterday' or YYYY-MM-DD"), folder: z.string().optional().describe("folder to search; defaults to the camera roll") },
    annotations: { readOnlyHint: true },
  }, async ({ when, folder }) => {
    const dir = folder || FOOTAGE;
    const day = resolveDate(when);
    const files = fs.readdirSync(dir).filter((f) => /\.(mp4|mov|m4v|mkv)$/i.test(f)).map((f) => path.join(dir, f));
    const clips = files.map((f) => ({ path: f, name: prettyName(f), ...probe(f) }))
      .filter((c) => !day || c.created.toISOString().slice(0, 10) === day)
      .sort((a, b) => a.created - b.created)
      .map((c) => ({ path: c.path, name: c.name, duration_s: +c.duration.toFixed(2), shot_at: c.created.toISOString() }));
    return ok(null, { day, count: clips.length, total_s: +clips.reduce((s, c) => s + c.duration_s, 0).toFixed(2), clips });
  });

  server.registerTool("make_reel", {
    title: "Make a reel",
    description: "Start a new reel project in kimo from clips: imports them, cuts them to fit length_s, and adds transitions matching the mood.",
    inputSchema: {
      clips: z.array(z.string()).min(1).describe("clip paths, e.g. from find_clips"),
      length_s: z.number().min(5).max(600).default(60),
      mood: z.enum(["upbeat", "calm", "dreamy", "energetic"]).default("upbeat"),
      name: z.string().optional(),
    },
  }, async ({ clips, length_s, mood, name }) => {
    const id = "reel-" + randomUUID().slice(0, 6);
    const kimo = await new KimoSession().start();
    await kimo.call("project", "project_set", { width: 960, height: 540, fps: 30, name: name || id });
    const tracks = {};
    for (const t of ["video", "titles", "captions"]) tracks[t] = (await kimo.call("timeline", "add_track", {})).track_id;
    const per = length_s / clips.length;
    const p = { id, kimo, tracks, clips: [], look: "natural", title: null, mood, renders: [], version: 0, captionClipIds: [] };
    for (const f of clips) {
      const a = await kimo.call("project", "import_media", { path: f });
      // a clip shorter than its slot is slowed down slightly so the reel hits the asked length
      const speed = Math.max(0.6, Math.min(1, a.duration / per));
      const dur = Math.min(per, a.duration / speed);
      const c = await kimo.call("timeline", "add_clip", { track_id: tracks.video, source_type: "media", asset_id: a.asset_id, start: 0, duration: dur, fit: "cover", speed });
      p.clips.push({ clip_id: c.clip_id, asset_id: a.asset_id, src: f, src_dur: a.duration, speed, dur, caption: prettyName(f) });
    }
    await layout(p);
    for (const c of p.clips.slice(1)) await kimo.call("effects", "add_transition", { clip_id: c.clip_id, kind: MOODS[mood] || "crossfade", duration: 0.6, ease: "in_out_cubic" });
    projects.set(id, p); lastProjectId = id;
    await save(p);
    return ok(null, { ...summary(p), mood, transitions: MOODS[mood], kimo: kimo.serverInfo });
  });

  server.registerTool("grade", {
    title: "Colour grade",
    description: "Apply a look to every clip in the reel: warm, cool, vivid, vintage, mono or natural.",
    inputSchema: { look: z.enum(["warm", "cool", "vivid", "vintage", "mono", "natural"]), project_id: z.string().optional() },
  }, async ({ look, project_id }) => {
    const p = getProject(project_id);
    for (const c of p.clips) {
      const r = await p.kimo.call("color_grade", "set_color_wheels", { clip_id: c.clip_id, ...(c.gradeFx ? { effect_id: c.gradeFx } : {}), lift: [0, 0, 0, 0], gain: [1, 1, 1, 1], ...LOOKS[look] });
      c.gradeFx = r.effect_id || c.gradeFx;
    }
    p.look = look; await save(p);
    return ok(null, { ...summary(p), graded_clips: p.clips.length });
  });

  server.registerTool("add_captions", {
    title: "Add captions",
    description: "Burn in a short caption on each shot (the place it was filmed). Re-runs automatically when the cut changes.",
    inputSchema: { project_id: z.string().optional() },
  }, async ({ project_id }) => {
    const p = getProject(project_id);
    const r = await writeCaptions(p); p.wantCaptions = true; await save(p);
    return ok(null, { ...summary(p), captions: r.count });
  });

  server.registerTool("add_title", {
    title: "Add a title",
    description: "Put a title card over the start or the end of the reel.",
    inputSchema: { text: z.string().min(1).max(60), where: z.enum(["start", "end"]).default("start"), project_id: z.string().optional() },
  }, async ({ text, where, project_id }) => {
    const p = getProject(project_id);
    if (p.titleClipId) await p.kimo.call("timeline", "delete_clip", { clip_id: p.titleClipId });
    const start = where === "start" ? 0 : Math.max(0, p.duration - 3.5);
    const r = await p.kimo.call("text", "add_text", { track_id: p.tracks.titles, text, start, duration: 3.5, size: 92, color: "#ffffff", shadow: 5, font: path.join(ROOT, "fonts/Fraunces-Var.ttf") });
    p.titleClipId = r.clip_id; p.title = { text, where };
    await save(p);
    return ok(null, { ...summary(p) });
  });

  server.registerTool("shorten", {
    title: "Shorten",
    description: "Make the reel shorter (or longer) by trimming every shot evenly to hit target_s. Default: half the current length.",
    inputSchema: { target_s: z.number().min(5).max(600).optional(), project_id: z.string().optional() },
  }, async ({ target_s, project_id }) => {
    const p = getProject(project_id);
    const before = p.duration;
    const target = target_s || Math.round(before / 2);
    const per = target / p.clips.length;
    for (const c of p.clips) c.dur = Math.min(per, c.src_dur / c.speed);
    await layout(p);
    if (p.wantCaptions) await writeCaptions(p);
    if (p.title?.where === "end") await p.kimo.call("timeline", "move_clip", { clip_id: p.titleClipId, start: Math.max(0, p.duration - 3.5) });
    await save(p);
    return ok(null, { ...summary(p), before_s: +before.toFixed(2) });
  });

  server.registerTool("render", {
    title: "Render",
    description: "Render the reel to an H.264 MP4 with kimo. Returns a URL the TV can play.",
    inputSchema: { resolution: z.enum(["540p"]).default("540p"), project_id: z.string().optional() },
  }, async ({ project_id }, extra) => {
    const p = getProject(project_id);
    const file = `${p.id}-v${p.version}.mp4`;
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (extra?._meta?.progressToken !== undefined) extra.sendNotification({ method: "notifications/progress", params: { progressToken: extra._meta.progressToken, progress: (Date.now() - t0) / 1000, message: "rendering" } }).catch(() => {});
    }, 2000);
    try {
      const r = await p.kimo.call("output", "export", { path: path.join(DATA, "renders", file), crf: 20 });
      const out = { project_id: p.id, url: `/renders/${file}`, duration_s: r.duration, render_s: +((Date.now() - t0) / 1000).toFixed(1), engine: r.kimo };
      p.renders.push(out);
      return ok(null, out);
    } finally { clearInterval(tick); }
  });

  server.registerTool("play_on_tv", {
    title: "Play on TV",
    description: "Play the latest render of the reel on the living-room screen (simulated Fire TV in the demo web app).",
    inputSchema: { project_id: z.string().optional(), device: z.string().default("Living Room TV") },
  }, async ({ project_id, device }) => {
    const p = getProject(project_id);
    const last = p.renders.at(-1);
    if (!last) throw new Error("Nothing rendered yet. Ask me to render the reel first.");
    Object.assign(tv, { playing: last.url, title: p.title?.text || p.id, device, since: new Date().toISOString() });
    return ok(null, { device, playing: last.url, duration_s: last.duration_s });
  });

  server.registerTool("kimo_raw", {
    title: "kimo (advanced)",
    description: "Advanced passthrough: call any kimo group tool (project, timeline, effects, text, color_grade, output, search_tools, kimo_describe...) on a reel's project.",
    inputSchema: { tool: z.string(), arguments: z.record(z.string(), z.any()).default({}), project_id: z.string().optional() },
  }, async ({ tool, arguments: a, project_id }) => {
    const p = getProject(project_id);
    const r = await p.kimo.rawTool(tool, a);
    return { content: r.content, isError: r.isError };
  });

  return server;
}

// ---------------------------------------------------------------- HTTP
const transports = new Map(); // Mcp-Session-Id -> transport
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".mp4": "video/mp4", ".png": "image/png", ".svg": "image/svg+xml", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".json": "application/json" };

function serveFile(res, file, req) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end("not found"); return; }
  const size = fs.statSync(file).size, type = MIME[path.extname(file)] || "application/octet-stream";
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const s = range[1] ? +range[1] : 0, e = range[2] ? +range[2] : size - 1;
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${s}-${e}/${size}`, "Accept-Ranges": "bytes", "Content-Length": e - s + 1 });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

async function readBody(req) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString(); return s ? JSON.parse(s) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // DNS-rebinding guard for a local server: only accept browser Origins from ourselves
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && !process.env.ALLOW_ANY_ORIGIN) { res.writeHead(403).end("forbidden origin"); return; }
  try {
    if (url.pathname === "/mcp") {
      const sid = req.headers["mcp-session-id"];
      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sid && transports.get(sid);
        if (!transport) {
          if (sid || !isInitializeRequest(body)) { res.writeHead(sid ? 404 : 400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: sid ? "Session not found" : "Bad Request: initialize first" }, id: null })); return; }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => transports.set(id, transport),
          });
          transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
          await buildServer().connect(transport);
        }
        await transport.handleRequest(req, res, body);
      } else if (req.method === "GET" || req.method === "DELETE") {
        const transport = sid && transports.get(sid);
        if (!transport) { res.writeHead(sid ? 404 : 400).end("unknown session"); return; }
        await transport.handleRequest(req, res);
      } else res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
      return;
    }
    if (url.pathname === "/tv") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(tv)); return; }
    if (url.pathname === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, protocol: PROTOCOL, sessions: transports.size, projects: projects.size })); return; }
    if (url.pathname.startsWith("/renders/")) return serveFile(res, path.join(DATA, "renders", path.basename(url.pathname)), req);
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(ROOT, "web", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    return serveFile(res, file, req);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(e.message || e) }, id: null }));
  }
});

httpServer.listen(PORT, HOST, () => console.log(`kimo-alexa MCP server (protocol ${PROTOCOL}, Streamable HTTP) on http://${HOST}:${PORT}/mcp  ·  simulated Alexa+ at http://${HOST}:${PORT}/`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { for (const p of projects.values()) await p.kimo.close(); process.exit(0); });
