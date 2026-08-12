#!/usr/bin/env node
/**
 * guanling over Streamable HTTP — one process, many agents.
 *
 * WHY THIS EXISTS (Robert, 2026-08-09: 「關令本身要是伺服器吧？一台服務多個客戶端。」)
 *
 * The stdio binding gives every agent its own spawned process, its own file, and its
 * own cron line. Measured consequences on this machine, both real:
 *   · Twelve agents would need twelve cron lines. Nine were never added, which is the
 *     entire reason nobody but me was using the tool.
 *   · hades caught this working tree mid-write TWICE in 25 minutes, because his config
 *     spawns a file I am actively editing — and stdio MCP cannot self-reload.
 * A server removes both: clients connect to something running, not to my editor.
 *
 * This is NOT a second product. The MCP spec: "Protocol semantics are identical on
 * every transport. A transport is a binding." dispatch() lives in server.mjs and is
 * shared verbatim; this file only carries messages and establishes WHO is asking.
 *
 * ─────────────────────────── identity ───────────────────────────
 * stdio: one process per agent, identity from the environment that spawned it.
 * HTTP:  one process for everyone, so identity must ride on each request — and be
 *        decided by the SERVER, not asserted by the caller.
 *
 * 🔑 That is a genuine upgrade over stdio, not just a port. Today GUANLING_AGENT is
 *    whatever the agent's own config says; the server believes it. Here the token
 *    decides, and a caller cannot name itself something else.
 *
 * ⚠️ Protocol-level sessions were REMOVED in MCP revision 2026-07-28 (`Mcp-Session-Id`
 *    is gone, streams are not resumable). So identity cannot be remembered across
 *    requests — it must be re-established on every single one. That is why
 *    enterRequest() is called per request and never cached.
 *
 * ─────────────────────────── security ───────────────────────────
 * All three are spec requirements, not my additions:
 *   1. Bind 127.0.0.1 only — never 0.0.0.0.
 *   2. Validate Origin — a remote web page can otherwise reach a local MCP server
 *      via DNS rebinding. Present-and-not-allowed ⇒ 403.
 *   3. Authenticate every connection.
 * 🔴 We already carry one service on the risk register for binding to the LAN.
 *    This one refuses to start if asked to bind anything but loopback.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';

import { dispatch, enterRequest } from './server.mjs';
import { isValidAgent } from './store-path.mjs';

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.GUANLING_PORT || 4620);
const HOST = process.env.GUANLING_HOST || '127.0.0.1';
const TOKENS_FILE = process.env.GUANLING_TOKENS || join(process.env.HOME || '', '.guanling', 'tokens.json');

// ── hades 2026-08-09 F1: the HTTP binding must NOT inherit an identity ────────
// server.mjs seeds CTX from GUANLING_AGENT at import. If this process has that
// variable set — same shell, same .env, an inherited pm2/systemd environment — the
// "no identity, fail loudly" guard can never fire, and a missed enterRequest() would
// silently write into the SERVER's own agent file instead of erroring.
// 🔑 His sharpest point: my mutation test proved that guard has teeth — and the test
//    environment surely had no GUANLING_AGENT set. So the guard is alive in the test
//    and possibly dead in production. A guard that only works where it is measured
//    is the exact failure this tool exists to name.
if ((process.env.GUANLING_AGENT || '').trim()) {
  process.stderr.write(
    `guanling-http: refusing to start with GUANLING_AGENT set ` +
    `(${process.env.GUANLING_AGENT}). This binding derives identity per request from ` +
    `the token; a process-wide identity would silently become the fallback when that ` +
    `fails. Unset it.\n`);
  process.exit(2);
}

// ── refuse to be reachable off-box ────────────────────────────────────────────
// A config typo must not be the thing that exposes every agent's task list to the
// LAN. This is a refusal, not a warning — the same principle the tool is built on.
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  process.stderr.write(
    `guanling-http: refusing to bind ${HOST}. Loopback only.\n` +
    `Every agent's task list is served here and there is no transport encryption.\n` +
    `If you genuinely need remote access, put a reverse proxy in front and keep\n` +
    `this bound to 127.0.0.1 — do not widen the bind.\n`);
  process.exit(2);
}

// ── token → agent ─────────────────────────────────────────────────────────────
// { "<token>": "<agent>" }. Loaded fresh on each request so adding an agent does
// not need a restart — and so a revoked token stops working immediately rather
// than living on in memory until someone remembers to restart.
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return null;
  const mode = statSync(TOKENS_FILE).mode & 0o077;
  if (mode) {
    process.stderr.write(
      `guanling-http: ${TOKENS_FILE} is group/world readable (mode ${mode.toString(8)}). ` +
      `chmod 600 it. Refusing to use it.\n`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(TOKENS_FILE, 'utf8')); } catch { return null; }

  // ⭐ ebola 2026-08-09 — an AUTH BYPASS, and the third instance of one shape today.
  // Object.entries() on a string yields [index, character] pairs, so a tokens file
  // containing just "just-a-string" made token "0" authenticate as agent "j".
  // An array did the same with index → element. Measured, both returned 200.
  //   nag.mjs  (db.tasks || [])       parsed JSON unchecked → broken store reads healthy
  //   http.mjs Object.entries(tokens) parsed JSON unchecked → broken tokens LET PEOPLE IN
  // 🩸 And the timing is the lesson: we agreed at 18:34 that "remember to sweep for
  //    siblings" does not work, and I wrote this one at 19:1x — AFTER that conversation.
  //    Which is the proof that the remedy has to be bound to the action, not to memory.
  //    The rule for this repo, all three sites: VALIDATE THE SHAPE OF PARSED JSON
  //    BEFORE USING IT AS A STRUCTURE.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`guanling-http: ${TOKENS_FILE} is not a JSON object. Refusing it.\n`);
    return null;                                      // fail CLOSED
  }
  // The value becomes an identity and then a filesystem path. Same reason as
  // resolveStore's check — but refuse the whole file rather than skipping one entry,
  // because a partly-loaded token table is a silently smaller allowlist.
  for (const [, agent] of Object.entries(parsed))
    if (!isValidAgent(agent)) {
      process.stderr.write(
        `guanling-http: ${TOKENS_FILE} maps a token to ${JSON.stringify(String(agent).slice(0,80))}, ` +
        `which is not a valid agent identifier. Refusing the whole file.\n`);
      return null;
    }
  return parsed;
}

// Constant-time compare over a fixed-width digest: a plain === on secrets leaks
// length and prefix through timing, and hashing first makes every comparison the
// same width regardless of token length.
const digest = (s) => createHash('sha256').update(String(s)).digest();
function agentForToken(token) {
  const tokens = loadTokens();
  if (!tokens || !token) return null;
  const want = digest(token);
  for (const [t, agent] of Object.entries(tokens))
    if (timingSafeEqual(digest(t), want)) return agent;
  return null;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

const server = createServer((req, res) => {
  // Spec: validate Origin. Browsers set it; our agents do not. Present-and-unknown
  // is the DNS-rebinding shape, so that is the case we reject.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin))
    return json(res, 403, rpcError(null, -32600, `origin not allowed: ${origin}`));

  if (req.method === 'GET' && req.url === '/health')
    return json(res, 200, { ok: true, service: 'guanling', bind: `${HOST}:${PORT}` });

  // Spec 2026-07-28 removed the GET stream and DELETE session endpoints.
  if (req.method !== 'POST') return json(res, 405, rpcError(null, -32600, 'POST only'));
  if (req.url !== '/mcp') return json(res, 404, rpcError(null, -32601, 'MCP endpoint is /mcp'));

  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const agent = agentForToken(auth);
  if (!agent) return json(res, 401, rpcError(null, -32001,
    'unauthorized — send Authorization: Bearer <token>. Tokens map to agent identity; ' +
    'you cannot choose your own name here.'));

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return json(res, 400, rpcError(null, -32700, 'parse error')); }

    // 🔑 Identity is established here and nowhere else, immediately before a fully
    //    synchronous dispatch. It is deliberately NOT cached between requests:
    //    there are no protocol sessions in this revision, and a cached identity is
    //    exactly how one agent's write lands in another agent's file.
    enterRequest(agent);
    let out;
    try { out = dispatch(msg); }
    catch (e) { return json(res, 500, rpcError(msg?.id, -32603, `${e.name}: ${e.message}`)); }

    if (out === null) return res.writeHead(202).end();   // notification
    return json(res, 200, out);
  });
});

// ─────────────────────── the sweep lives here now ───────────────────────
// This is the whole reason Robert asked for a server. Under cron, every agent needed
// its own crontab line; twelve agents, nine lines never added, and that is the entire
// measured reason nobody but me was using the tool. A schedule that each user has to
// install is a schedule most users do not have.
//
// The agent list comes from the token table — the same source that decides identity.
// No separate registry to drift out of sync: if you can authenticate, you get swept.
// 🔑 That is deliberate. A roster maintained beside the auth table is one more pair of
//    copies with no signal on the day they diverge, which is the defect class this
//    codebase has produced three times today.
const SWEEP_AT = (process.env.GUANLING_SWEEP_AT || '09:30').trim();   // local HH:MM
const NAG = join(HERE_DIR, 'nag.mjs');
let lastSweptDay = null;

function sweepOnce(now = new Date()) {
  const tokens = loadTokens() || {};
  const agents = [...new Set(Object.values(tokens))];
  for (const agent of agents) {
    const r = spawnSync(process.execPath, [NAG, agent], { encoding: 'utf8', timeout: 30000 });
    // Exit codes are the contract: 0 nothing, 1 needs attention, 2 store unreadable.
    // 2 is NOT silence — it means that agent is not wired up, and saying nothing about
    // it is precisely how an unwired agent looks identical to a healthy one.
    if (r.status === 2)
      process.stderr.write(`[sweep] ${agent}: STORE UNREADABLE — ${(r.stderr || '').trim()}\n`);
    else if (r.status === 1)
      wake(agent, r.stdout);
    else
      process.stderr.write(`[sweep] ${agent}: clean\n`);
  }
}

function wake(agent, findings) {
  process.stderr.write(`[sweep] ${agent}: findings — waking a session\n`);
  const cfg = join(HERE_DIR, `.sweep-mcp-${agent}.json`);
  writeFileSync(cfg, JSON.stringify({ mcpServers: { guanling: {
    command: process.execPath, args: [join(HERE_DIR, 'server.mjs')],
    env: { GUANLING_AGENT: agent },
  }}}), 'utf8');
  const p = spawn('/home/dev/.local/bin/claude',
    ['--dangerously-skip-permissions', '--strict-mcp-config', '--mcp-config', cfg,
     '--model', 'claude-sonnet-4-6', '--print', '-p',
     `你的任務清單有幾筆需要現在處理掉。資料來自你自己的 guanling 任務檔。\n\n${findings}\n\n` +
     `用 mcp__guanling__* 逐筆處理，每一筆都要落到一個【動作】。\n` +
     `🔴 你【只能】改自己的任務，不要碰任何其他系統、檔案、服務。\n` +
     `不確定就把 next_step 改成一個具體的查證動作，不要為了清乾淨而關單。`],
    { detached: true, stdio: 'ignore', env: { ...process.env, HOME: '/home/dev', GUANLING_AGENT: '' } });
  p.unref();
}

// Check every minute; fire once per day at SWEEP_AT. Cheap, and it survives the
// process being restarted at an awkward time — unlike "setTimeout until 09:30",
// which silently never fires if the server restarts at 09:31.
setInterval(() => {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const day = now.toDateString();
  if (hhmm === SWEEP_AT && day !== lastSweptDay) { lastSweptDay = day; sweepOnce(now); }
}, 60000).unref?.();

// 🔑 2026-08-10（Robert 令「他們要一套的阿」→ 選甲）：讓【核心的 bind】當那把鎖。
//   plugin 每個 session 啟動時都會試著把這支拉起來（見 server.mjs ensureScheduler）。
//   十幾個 agent 同時開 session ⇒ 十幾個人同時 spawn 這支 ⇒ 但 listen 只有一個會成功。
//   ⇒ **輸的那些必須安靜地正常結束**，否則 log 會被 crash stack 淹掉、也會讓人以為壞了。
//   📏 不用 lockfile、不用 pidfile：那兩個都要處理「持有者已死但檔還在」，而 bind 沒有那個問題
//      —— 行程死了，埠就自動還回去。**用作業系統已經保證的互斥，不要自己再發明一個。**
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    process.stderr.write(`guanling-http: ${HOST}:${PORT} already served by another instance — nothing to do, exiting cleanly.\n`);
    process.exit(0);          // 0 = 正常：別人已經在跑了，這正是我們要的狀態
  }
  process.stderr.write(`guanling-http: listen failed (${e?.code || e?.message}) — refusing to run half-started.\n`);
  process.exit(2);            // 其他錯誤要大聲：那不是「已經有人跑」，是真的起不來
});

server.listen(PORT, HOST, () => {
  const n = Object.keys(loadTokens() || {}).length;
  process.stderr.write(
    `guanling-http listening on ${HOST}:${PORT}/mcp — ${n} token(s), daily sweep at ${SWEEP_AT}\n` +
    (n === 0 ? `⚠️  no tokens: every request will be rejected 401 until you add some.\n` : ''));
});
