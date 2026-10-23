// Simulated Alexa+: a deterministic planner turns an utterance into MCP tool calls,
// sent over Streamable HTTP to the kimo-alexa MCP server. No LLM; the planner is a
// stand-in for the Alexa+ agent so the MCP side can be shown end to end.
import { McpHttpClient } from "./mcp-client.js";

const $ = (id) => document.getElementById(id);
const mcp = new McpHttpClient(new URL("/mcp", location.href).href, "2025-11-25");
const ctx = { project: null, lastRender: null, offeredTv: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setRing(state, label) { $("ring").className = "ring " + state; $("state").textContent = label || ""; }
function bubble(who, text) { const d = document.createElement("div"); d.className = "msg " + who; d.textContent = text; $("chat").append(d); $("chat").scrollTop = 1e9; return d; }
function short(v) { const s = JSON.stringify(v, (k, x) => (typeof x === "string" && x.includes("/") ? x.split("/").pop() : x)); return s.length > 170 ? s.slice(0, 167) + "…" : s; }
function showProject() {
  const p = ctx.project; if (!p) return;
  $("proj").innerHTML = `project <b>${p.project_id}</b> · v${p.version}<br>length <b>${p.duration_s}s</b> · ${p.clips} shots · look <b>${p.look}</b> · captions ${p.captions ? "on" : "off"}${p.title ? ` · title <b>“${p.title.text}”</b> at ${p.title.where}` : ""}`;
}

async function tool(name, args, resultLine) {
  const li = document.createElement("li"); li.className = "call";
  li.innerHTML = `<div class="top"><span class="name">${name}</span><span class="st">⋯</span></div><div class="args">${short(args)}</div>`;
  $("calls").append(li); li.scrollIntoView({ block: "end" });
  const t0 = performance.now();
  const timer = setInterval(() => { li.querySelector(".st").textContent = `⋯ ${((performance.now() - t0) / 1000).toFixed(0)}s`; }, 500);
  try {
    const r = await mcp.callTool(name, args, (p) => { li.querySelector(".st").textContent = `⋯ ${p.message || ""} ${Math.round(p.progress)}s`; });
    clearInterval(timer);
    li.classList.add("done"); li.querySelector(".st").textContent = `✓ ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    const line = resultLine?.(r); if (line) { const d = document.createElement("div"); d.className = "res"; d.textContent = "→ " + line; li.append(d); }
    if (r.project_id && r.duration_s !== undefined && r.clips !== undefined) { ctx.project = r; showProject(); }
    return r;
  } catch (e) {
    clearInterval(timer); li.classList.add("err"); li.querySelector(".st").textContent = "✗"; throw e;
  }
}

// ---- deterministic planner: utterance -> list of tool calls
function seconds(u, fallback) {
  const words = { one: 1, two: 2, three: 3, half: 0.5, a: 1 };
  let m = u.match(/(\d+|one|two|three|a|half)[\s-]*(?:a\s+)?minute/); if (m) return Math.round((words[m[1]] ?? +m[1]) * 60);
  m = u.match(/(\d+)\s*(?:-|\s)?sec/); if (m) return +m[1];
  return fallback;
}
function dayOf(u) { return (u.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday)/) || [])[1]; }

async function plan(utterance) {
  const u = utterance.toLowerCase().replace(/^alexa[, ]*/, "");
  const look = (u.match(/\b(warm|cool|vivid|vintage|mono|natural)\b/) || [])[1] || (/black and white/.test(u) && "mono");
  const mood = (u.match(/\b(upbeat|calm|dreamy|energetic)\b/) || [])[1];

  if (/\breel\b|\bvideo\b|\bmontage\b/.test(u) && /\bmake|\bcreate|\bcut\b/.test(u)) {
    const when = dayOf(u) || "today";
    const found = await tool("find_clips", { when }, (r) => `${r.count} clips from ${r.day} (${r.total_s}s)`);
    if (!found.count) return `I couldn't find any clips from ${when}.`;
    const length_s = seconds(u, 60);
    await tool("make_reel", { clips: found.clips.map((c) => c.path), length_s, mood: mood || "upbeat" }, (r) => `${r.project_id}: ${r.clips} shots, ${r.duration_s}s, ${r.transitions} transitions`);
    if (look) await tool("grade", { look }, (r) => `${r.look} grade on ${r.graded_clips} shots`);
    await tool("add_captions", {}, (r) => `${r.captions} captions burned in`);
    ctx.lastRender = await tool("render", { resolution: "540p" }, (r) => `${r.url.split("/").pop()} · ${r.duration_s}s · rendered in ${r.render_s}s`);
    ctx.offeredTv = true;
    return "Your reel is ready. Want it on the TV?";
  }

  if (/shorter|longer|trim|tighter|title|grade|warmer|cooler|caption/.test(u) && ctx.project) {
    const done = [];
    if (/shorter|tighter|trim|longer/.test(u)) {
      const target_s = seconds(u, undefined);
      const r = await tool("shorten", target_s ? { target_s } : {}, (r) => `${r.before_s}s → ${r.duration_s}s, same project`);
      done.push(`it's ${Math.round(r.duration_s)} seconds now`);
    }
    if (/title/.test(u)) {
      const where = /\bend\b/.test(u) ? "end" : "start";
      const text = (utterance.match(/["“](.+?)["”]/) || [])[1] || "Saturday Trip";
      await tool("add_title", { text, where }, (r) => `“${r.title.text}” at the ${r.title.where}`);
      done.push(`the title's at the ${where}`);
    }
    if (look) { await tool("grade", { look }, (r) => `${r.look} grade`); done.push(`it has a ${look} look`); }
    ctx.lastRender = await tool("render", { resolution: "540p" }, (r) => `${r.url.split("/").pop()} · ${r.duration_s}s · rendered in ${r.render_s}s`);
    ctx.offeredTv = true;
    return `Done. ${done.join(", and ").replace(/^./, (c) => c.toUpperCase())}.`;
  }

  if (/\b(tv|television|play it|show it)\b/.test(u) || (ctx.offeredTv && /^(yes|yeah|sure|please)/.test(u))) {
    const r = await tool("play_on_tv", {}, (r) => `${r.device} ▶ ${r.playing.split("/").pop()}`);
    return `Playing it on the ${r.device}.`;
  }
  return "Sorry, I can only make and edit reels in this demo.";
}

// ---- "voice": the utterance appears word by word like live transcription
async function say(text) {
  setRing("listening", "Listening…");
  const b = bubble("user", "");
  for (const w of text.split(" ")) { b.textContent += (b.textContent ? " " : "") + w; await sleep(170); }
  await sleep(400);
  setRing("thinking", "Working on it…");
  const sep = document.createElement("li"); sep.className = "call scene"; sep.textContent = `— “${text.replace(/^Alexa,\s*/i, "")}”`; $("calls").append(sep);
  let reply;
  try { reply = await plan(text); } catch (e) { reply = "Sorry, something went wrong: " + e.message; console.error(e); }
  setRing("speaking", "Speaking");
  bubble("alexa", reply);
  const audio = window.ALEXA_VOICE?.[reply]; if (audio) { try { await new Audio(audio).play(); } catch {} }
  await sleep(2200);
  setRing("idle", "Say “Alexa, …”");
  window.__lastReply = reply;
  return reply;
}
window.say = say;

// ---- TV: polls the server's /tv state (what play_on_tv set)
let playing = null;
setInterval(async () => {
  try {
    const t = await (await fetch("/tv", { cache: "no-store" })).json();
    if (t.playing && t.playing !== playing) {
      playing = t.playing; const v = $("video"); v.src = t.playing; v.muted = true;
      $("screen").classList.add("on"); $("tvbadge").textContent = `▶ ${t.device || "TV"} · ${t.title || ""}`;
      v.play().catch(() => {});
    }
  } catch {}
}, 700);

$("form").addEventListener("submit", (e) => { e.preventDefault(); const v = $("say").value.trim(); if (v) { $("say").value = ""; say(v); } });

(async () => {
  try {
    const init = await mcp.connect();
    const { tools } = await mcp.listTools();
    $("conn").innerHTML = `MCP <b>${init.serverInfo.name}</b> · protocol <b>${init.protocolVersion}</b> · Streamable HTTP · session ${mcp.sessionId.slice(0, 8)} · ${tools.length} tools`;
    window.__ready = true;
  } catch (e) { $("conn").textContent = "MCP connection failed: " + e.message; }
})();
