#!/usr/bin/env node
/**
 * guanling (關令) — a task MCP server that refuses.
 *
 * WHY THIS EXISTS
 *   A real task list grew to 280 items. Sixteen were marked "in progress".
 *   Not one of them was actually being worked on.
 *
 *   The missing thing was not a tool — there already was a list. The missing
 *   thing was anything that forced a decision. Every tool in that list said
 *   yes to everything, so the list recorded intentions and never spent them.
 *
 *   What makes Linear work is not its feature set, it is its refusals: a small
 *   fixed set of states you cannot extend, and limits you cannot argue with.
 *   This server copies the refusals, not the features.
 *
 * THE GATES (each is a refusal, not a warning)
 *   1. task_add without `owner` or `next_step` is rejected. If you cannot say
 *      who owns it and what happens next, it is a wish, not a task.
 *   2. Five states, hardcoded. There is no API to add a sixth. Custom statuses
 *      are how a list starts rotting.
 *   3. Moving to `doing` past the WIP limit is rejected, and the error names
 *      what currently occupies the limit so you have to close something.
 *   4. Items with a `source` land in `triage`, never straight into `todo`.
 *   5. Closing requires a `reason`. "Why it was closed" outlives "it closed".
 *   6. cycle_roll increments a visible `rolled` counter and escalates anything
 *      rolled 3+ times. It never silently drops work.
 *
 * NAME
 *   關令尹喜 was the gatekeeper at Hangu Pass who would not let Laozi through
 *   until he wrote his teaching down — which is why the Tao Te Ching exists.
 *   Same idea: you do not get through until you write it down.
 *
 * STORAGE
 *   One JSON file, written atomically (tmp + rename). Deliberately not a
 *   database: the scale is hundreds of rows, and a plain file stays readable
 *   by humans, diffable in git, and backed up by `cp`.
 *   The full string is built before the file is touched, so an exception
 *   mid-serialisation leaves the previous file intact.
 *
 * CONFIG (environment)
 *   GUANLING_AGENT  identity for this instance          (default "unknown")
 *   GUANLING_FILE   path to the JSON store   (default: $HOME/<agent>/.guanling.json if
 *                   that folder exists, else $HOME/.guanling/<agent>.json — store-path.mjs)
 *   GUANLING_WIP    max concurrent `doing` items        (default 6, was 3 until 2026-08-10)
 *
 *   Set GUANLING_AGENT and let the path derive from it. Do NOT set GUANLING_FILE
 *   unless you have a specific reason: the sweep resolves the same way from the
 *   same name, so a custom path takes you out of it — and it then reports
 *   "nothing wrong" about an agent it cannot see.
 *   (This paragraph said "the sweep that scans ~/.guanling/" until 1.9.0. That
 *   stopped being true when stores moved into each agent's own folder, and the
 *   sentence survived the change it described — the usual way a comment lies.)
 *   Two instances sharing one file overwrite each other —
 *   there is no lock — which is why the name is mandatory and collisions are
 *   detected rather than merged.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, appendFileSync, accessSync, constants as FS } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
// 甲（2026-08-10）新增：plugin 要能把排程行程帶起來。全部先在這裡 import ——
// 🩸 我第一版把它們寫成函式內的 require()，而這是 .mjs（ESM）⇒ require 不存在 ⇒
//    整段會在 try/catch 裡靜默失效，而工具照常回 ok。那正是黑帝斯今早抓到的 outbox 同一顆
//    （識別字沒宣告 + catch 吞掉 = 功能不存在但看起來正常）。我在同一天差點再犯一次。
import { createConnection } from 'node:net';
import { openSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveStore, isValidAgent } from './store-path.mjs';

// Is this file the process entrypoint (stdio binding), or is it imported by another
// binding (http.mjs) / by the tests? The env-based startup guard below only makes
// sense for stdio, where the environment IS the identity. An importer supplies
// identity per request instead — and had to set a dummy GUANLING_AGENT just to get
// past the guard, which is a smell: a safety check that forces callers to fake data
// has stopped being a safety check.
const IS_MAIN = !!(process.argv[1] && process.argv[1].endsWith('server.mjs'));

const VERSION = '2.10.0';   // ⚠️ 三處版號必須一致：這裡 + plugin.json + package.json（用 ./sync-package.sh）
                           // 2.4.0 出貨時我漏了這一個 ⇒ 伺服器自報 2.3.1 而套件說 2.4.0。
                           // 版號不一致的代價是【診斷時被誤導】，不是難看：問「你跑哪版」
                           // 拿到的答案會跟安裝紀錄對不起來，而那正是出事時唯一的線索。
// ⭐ 2026-08-09 Robert:「我現在都用開發模式啟用欸」—— that one line was the answer.
// I had made guanling the ONLY thing on this machine arriving via .mcp.json, then spent
// an evening learning to defeat the approval gate on that path. Everything that actually
// loads here (telegram, pangu relay/huatuo/pulse-query) arrives as a PLUGIN. I was
// repairing a road nobody travels — and the question I should have asked is the one I
// had already said three times today: what are people actually using?
//
// As a plugin the server is spawned with CLAUDE_PROJECT_DIR set to the agent's own
// workspace (measured, not assumed: a probe returned /home/dev/qimenzi). So identity
// derives from the workspace, and NO agent has to configure anything.
// 🔑 This does not weaken the original fail-closed rule. That rule existed because a
//    default FILENAME is shared by everyone; a workspace path is genuinely per-agent.
const AGENT = (() => {
  const explicit = (process.env.GUANLING_AGENT || '').trim();
  if (explicit) return explicit;
  const proj = (process.env.CLAUDE_PROJECT_DIR || '').trim();
  if (!proj) return '';
  const base = proj.replace(/\/+$/, '').split('/').pop() || '';
  return isValidAgent(base) ? base : '';     // an unusable name is no name — stay closed
})();
const EXPLICIT_FILE = (process.env.GUANLING_FILE || '').trim();

// Refuse to start unconfigured. Several agents commonly share one machine and one
// HOME, so a default filename is not isolation — it is a shared file none of them
// knows they are sharing. The old default ("unknown") merged every unconfigured
// instance into one store and silently overwrote their work: no error, no warning,
// just one agent's tasks appearing in another's list. Fail loudly instead.
if (IS_MAIN && !EXPLICIT_FILE && !AGENT) {
  process.stderr.write(
    'guanling: refusing to start — no GUANLING_AGENT and no GUANLING_FILE.\n' +
    'Set GUANLING_AGENT (or GUANLING_FILE) so this instance owns its own store.\n' +
    'Without one, every unconfigured instance sharing this HOME would read and\n' +
    'overwrite the same file, and nothing would report it.\n');
  process.exit(2);
}

// ⭐ 2026-08-09 Robert: 「關令本身要是伺服器吧？一台服務多個客戶端。」
// MCP 規格同意他：Streamable HTTP 的伺服器「是一個獨立程序，可以處理多個 client
// 連線」，而「協定語意在每一種傳輸上都相同 —— 傳輸只是一層綁定」。
// 所以這【不是】兩個產品，是同一支伺服器兩種接法。工具邏輯一行都不用改，
// 唯一要動的是身分：stdio 時身分來自啟動它的環境變數（一個程序服務一個 agent），
// HTTP 時一個程序服務所有人 ⇒ 身分必須跟著每一次請求走。
//
// 🔑 這樣做安全的【唯一理由】是：這支檔案裡 async/await 出現 0 次，每一個 handler
//    都是同步的（readFileSync/writeFileSync），所以一個請求不可能在處理到一半時
//    被另一個請求插進來。selftest 有一條會在這個前提被破壞時變紅。
//    ⚠️ 如果哪天有人在 handler 裡加了 await，這個 context 就會在請求之間洩漏，
//       而症狀是【A 的資料寫進 B 的檔案】—— 安靜、且事後很難重建。
let CTX = { agent: AGENT, file: resolveStore(AGENT) };
export function enterRequest(agent) {          // HTTP 入口每個請求呼叫一次
  CTX = { agent, file: resolveStore(agent) };
}
export const currentAgent = () => CTX.agent;
// ⭐ 2026-08-10 Robert:「那要預設都改6吧」（賈維斯回報 3 對多域 agent 會擋到正常工作）。
//    3 → 6。舊值 3 保留在 WIP_LEGACY_DEFAULT，因為【判斷一個 store 的 3 是不是使用者
//    自己選的】需要知道舊預設是多少 —— 沒有這個常數就只能猜。
const WIP_LEGACY_DEFAULT = 3;
const WIP_DEFAULT = Number(process.env.GUANLING_WIP || 6);

// Five states, hardcoded. There is deliberately no API to add a sixth.
const STATES = ['triage', 'todo', 'doing', 'done', 'dropped'];
const OPEN   = ['triage', 'todo', 'doing'];

const nowISO = () => new Date().toISOString();
const days = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

function load() {
  // 🔴 An importer that forgets enterRequest() must fail loudly. The mutation test
  // showed the alternative: without per-request identity, every agent's writes piled
  // into one file and nothing complained. Silence is the failure mode this whole tool
  // exists to prevent, so it must not be how its own plumbing fails.
  if (!CTX.agent && !EXPLICIT_FILE)
    throw new Error('guanling: no identity for this call — the HTTP binding must call ' +
                    'enterRequest(agent) before dispatch(). Refusing to guess a store.');
  if (!existsSync(CTX.file)) {
    return { version: 1, agent: CTX.agent, wip_limit: WIP_DEFAULT,
             cycle: { n: 1, start: nowISO(), days: 14 }, seq: 0, tasks: [] };
  }
  const db = JSON.parse(readFileSync(CTX.file, 'utf8'));
  // Second collision mode: two differently-named instances pointed at one file.
  // The store records who created it, so mismatched ownership is detectable —
  // and a detectable collision must not be a silent one.
  if (CTX.agent && db.agent && db.agent !== CTX.agent)
    throw new Error(
      `store ownership mismatch: ${CTX.file} belongs to "${db.agent}", but this instance ` +
      `is "${CTX.agent}". Two instances are pointed at one file; give each its own GUANLING_FILE.`);

  // 🩸 2026-08-10, found by testing before answering jarvis (Robert: "3 太少了吧?").
  //    GUANLING_WIP was documented as setting the cap, but it was only read when the store
  //    was FIRST CREATED — the check reads db.wip_limit. So for anyone who had already
  //    started, setting the variable did exactly nothing, silently.
  //    ⇒ The people it failed for are precisely the people who had been using the tool.
  //    📏 A knob that works only before you have any data is a knob that works only for
  //       people who do not need it yet.
  // ✅ An explicitly-set env now wins AND is written back, so the store never claims a
  //    limit it is not enforcing — `wip: 3/6` must mean the 6 is real.
  const envWip = (process.env.GUANLING_WIP || '').trim();
  if (envWip && Number(envWip) > 0) {
    // An explicitly-set env is a deliberate choice and wins outright — including when it
    // equals the old default. That is what stops the raise below from overriding someone
    // who actually wants 3.
    if (db.wip_limit !== Number(envWip)) {
      db.wip_limit = Number(envWip);
      db._wip_source = `GUANLING_WIP env (${envWip})`;
    }
  } else if (db.wip_limit === WIP_LEGACY_DEFAULT && !db._wip_source) {
    // 🩸 2026-08-10 second half of the same defect. Robert:「那要預設都改6吧」.
    //    Raising WIP_DEFAULT alone would have reached NOBODY who was already using the
    //    tool: the cap is read from db.wip_limit, and every existing store had 3 written
    //    into it at creation. I nearly shipped exactly the bug I had just finished fixing.
    // 📏 A default only governs stores that do not exist yet. Changing one is a MIGRATION,
    //    not an edit to a constant — and the people it silently skips are the current users.
    // The discriminator for "nobody chose this": still on the old default AND no recorded
    // source. An explicit env never reaches here, so a deliberate 3 survives.
    db.wip_limit = WIP_DEFAULT;
    db._wip_source = `raised ${WIP_LEGACY_DEFAULT}→${WIP_DEFAULT} (default change 2026-08-10)`;
  }
  return db;
}

function save(db) {
  // Build the whole string first, then touch the file. If serialisation throws
  // halfway, the previous file is still intact.
  const body = JSON.stringify(db, null, 2);
  mkdirSync(dirname(CTX.file), { recursive: true });
  const tmp = `${CTX.file}.tmp-${process.pid}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, CTX.file);        // rename is atomic: readers never see a partial file
}

// A next_step must name an action, not gesture at one. Character count is not the
// test — CJK carries far more meaning per character than Latin ("改兩份模板" is five
// characters and completely actionable; "ship" is four and is not). So the check is
// a placeholder list plus a floor low enough to be language-neutral.
// ⚠️ This is deliberately incomplete: it catches known filler, not vagueness in
// general. The daily scan is the real net — this only stops the obvious cases at
// the door so the scan is not immediately full of things the gate just let through.
const FILLER = new Set([
  'x', 'xx', 'tbd', 'todo', 'tba', '?', '??', '-', '--', 'n/a', 'na', 'none',
  'later', 'soon', 'fix', 'fix it', 'do it', 'check', 'look', 'see', 'ship',
  '看看', '再看', '再說', '處理', '處理一下', '待定', '待辦', '之後', '有空再說', '再處理',
]);
const isFiller = (v) => {
  // Collapse internal whitespace too — ebola 2026-08-09: "fix  it" (two spaces)
  // slipped past the "fix it" entry. A blocklist that can be evaded by a space is
  // weaker than it reads.
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[。．.!！]+$/, '');
  return !t || t.length < 2 || FILLER.has(t);
};

// A next_step that describes waiting is not an action *you* can take, and nothing
// will ever mark it done — hades measured the decay at five minutes: he carried three
// "waiting on Robert" items, all three were already false, and one had been resolved
// by someone else six minutes after he wrote it.
//
// 🔑 The fix is not more words in FILLER. That list is bound to the literal string, so
// it blocks the phrasings you thought of and nothing else. This is bound to the
// PROPERTY: if the next step is "wait", then say who — which turns an item that rots
// invisibly into one the sweep can see and age.
// Waiting is legitimate; waiting *anonymously* is not.
// ⚠️ v1: I bound this to a leading 等 and my own negative control caught it —
// 「等價交換的設計要重寫」 got rejected. 等 is a verb here only when it governs
// someone; in 等價/等級/等於 it is part of a word. Binding to the character was the
// same literal-matching mistake hades had just told me to stop making.
// So: 等 counts only when followed by a separator (等 Robert …) or when the step
// names the thing being waited FOR (回覆/確認/決定/回報/答覆/核准).
const WAITING = new RegExp([
  '^\\s*等[\\s:：,，]',                       // 等 + 分隔符 ⇒ 後面是對象
  '^\\s*(等|待|候)[^\\s]{0,8}(回覆|回复|確認|确认|決定|决定|回報|答覆|核准|批准|審核|回信)',
  '^\\s*(waiting|awaiting|pending|blocked)\\b',
  '^\\s*follow[\\s-]?up\\b',
  '^\\s*(追蹤中|跟進中|持續(觀察|追蹤)|觀察中|待辦中)',
].join('|'), 'i');
const isWaiting = (v) => WAITING.test(String(v || '').trim());

// 事前約束（Robert 令 2026-08-09：「稽核沒用吧！我要即時跟事前約束」）
//
// blocked_on naming a PERSON is the exact move this tool exists to stop: it records
// your belief about someone else's work in a place they cannot see, and then reads
// like tracking. So it is refused at the moment of the write unless the ticket
// actually went through task_delegate — i.e. unless an object exists on their side.
//
// 🔑 Why here and not at the transport: a hook on the message bus would have to guess
// which free-text messages are delegations, and a wrong guess blocks real work between
// agents. This check has no such ambiguity — the field is either backed by a delegation
// record or it is not. Constrain where the question has a definite answer.
//
// Non-person blockers stay free-text on purpose: "waiting for the next dist release",
// "PROD restart window" are real and have nobody to notify.
// ⚠️ 9527 is a real agent here and my first pattern required a letter or CJK start,
// so it sailed through. Agent ids are not obliged to look like words.
const PERSONISH = /^[@]?[A-Za-z][A-Za-z0-9._-]{1,30}$|^[\u4e00-\u9fff]{2,6}$|^\d{3,10}$/;
const looksLikePerson = (v) => {
  const t = String(v || '').trim();
  if (!t) return false;
  // Anything with a clause, a date, or explanatory punctuation is a condition, not a name.
  if (/[（(）)，,。;；:：\s]/.test(t) && t.length > 8) return false;
  return PERSONISH.test(t.replace(/^@/, ''));
};

const err = (m) => ({ error: m });
const find = (db, id) => db.tasks.find((t) => t.id === Number(id));

// ───────────────────────────── tools ─────────────────────────────
const TOOLS = {
  task_add: {
    annotations: { title: 'Open a task', readOnlyHint: false, destructiveHint: false },
    description:
      'Open a task. Both `owner` and `next_step` are REQUIRED and the call is ' +
      'rejected without them — this is a deliberate gate, not a validation ' +
      'oversight: something with no owner and no next action is a wish, not a ' +
      'task. Pass `source` for externally-originated items; they land in ' +
      'triage rather than todo.',
    schema: {
      type: 'object',
      properties: {
        title:      { type: 'string', description: 'One line: what needs doing.' },
        owner:      { type: 'string', description: 'Who owns it. Required. If unknown, do not open the task.' },
        next_step:  { type: 'string', description: 'The next concrete action. Required.' },
        source:     { type: 'string', description: 'External origin. If set, the task starts in triage.' },
        blocked_on: { type: 'string', description: 'Who or what it is waiting on.' },
      },
      required: ['title', 'owner', 'next_step'],
    },
    run(db, a) {
      if (!a.title?.trim())     return err('Rejected: title is empty.');
      if (!a.owner?.trim())     return err('Rejected: no owner. If you cannot say who owns it, it is not a task.');
      if (!a.next_step?.trim()) return err('Rejected: no next_step. Without a next action this is a wish, not a task.');
      if (looksLikePerson(a.blocked_on))
        return err(`Rejected: blocked_on "${a.blocked_on.trim()}" names a person, but nothing was ` +
                   `sent to them — this ticket would record your belief about their work in a place ` +
                   `they cannot see. Use task_delegate so an object exists on their side. ` +
                   `(For non-person blockers — a release, a restart window — describe the condition.)`);
      if (isWaiting(a.next_step) && !a.blocked_on?.trim())
        return err(`Rejected: next_step "${a.next_step.trim()}" describes waiting, so name who ` +
                   `you are waiting on in blocked_on. Waiting is fine; waiting anonymously is ` +
                   `how an item rots — nothing will ever mark it done, and the sweep cannot see it.`);
      if (isFiller(a.next_step))
        return err(`Rejected: next_step "${a.next_step.trim()}" is filler, not an action. ` +
                   `Write what you would actually do next — specific enough that you could start ` +
                   `on it after forgetting everything about this task.`);
      const t = {
        id: ++db.seq, title: a.title.trim(), owner: a.owner.trim(),
        next_step: a.next_step.trim(), status: a.source ? 'triage' : 'todo',
        source: a.source || null, blocked_on: a.blocked_on || null,
        blocked_since: a.blocked_on ? nowISO() : null,
        progressed: nowISO(),          // created counts as the first progress
        cycle: db.cycle.n, rolled: 0, created: nowISO(), updated: nowISO(), closed_reason: null,
      };
      db.tasks.push(t);
      return { ok: true, id: t.id, status: t.status };
    },
  },

  task_update: {
    annotations: { title: 'Update a task', readOnlyHint: false, destructiveHint: true },
    description:
      'Update a task. `status` must be one of triage/todo/doing/done/dropped — ' +
      'there is no way to add another. Moving into `doing` when the WIP limit ' +
      'is already reached is REJECTED, and the error lists what currently ' +
      'occupies the limit. Closing (done/dropped) REQUIRES a `reason`.',
    schema: {
      type: 'object',
      properties: {
        id:         { type: 'number' },
        status:     { type: 'string', enum: STATES },
        owner:      { type: 'string' },
        next_step:  { type: 'string' },
        blocked_on: { type: 'string', description: 'Empty string clears it.' },
        reason:     { type: 'string', description: 'Required when closing as done or dropped.' },
      },
      required: ['id'],
    },
    run(db, a) {
      const t = find(db, a.id);
      if (!t) return err(`No task #${a.id}.`);
      if (a.status) {
        if (!STATES.includes(a.status))
          return err(`Rejected: status must be one of ${STATES.join('/')} — got "${a.status}".`);
        if (a.status === 'doing' && t.status !== 'doing') {
          const wip = db.tasks.filter((x) => x.status === 'doing').length;
          if (wip >= db.wip_limit) {
            const cur = db.tasks.filter((x) => x.status === 'doing').map((x) => `#${x.id} ${x.title}`);
            return err(
              `Rejected: ${wip} tasks already in doing, at the limit of ${db.wip_limit}.\n` +
              `Close one before starting another. Currently in progress:\n  ${cur.join('\n  ')}`);
          }
        }
        if ((a.status === 'done' || a.status === 'dropped') && !a.reason?.trim())
          return err(`Rejected: closing as ${a.status} requires a reason. Why it closed outlives that it closed.`);
        if (a.status === 'done' || a.status === 'dropped') t.closed_reason = a.reason.trim();
        t.status = a.status;
      }
      // Same validation as task_add, via the same functions — not a second copy.
      // Found by ebola 2026-08-09: this path had no checks at all, so a task could be
      // opened clean and then updated to owner="" next_step="" and stay in the list.
      // The gate was on one door, and an invariant enforced only at creation is not an
      // invariant — every later write is a legal call returning ok:true.
      //
      // ⭐ hades 2026-08-09, and this is the structural one: `updated` was the tool's ONLY
      // clock, and several calls that change nothing reset it. Four independent attack
      // lines converged here — a no-op task_update, snooze, a self-asserted ack, and
      // re-delegation — which is why the fix belongs in the clock and not in those four.
      // The one field was being asked to answer two different questions: "has anyone
      // touched this?" and "is this actually moving?". Only the second one is what an
      // alarm should read.
      //   updated    — any write at all (display, "when did I last look at this")
      //   progressed — the state genuinely advanced: status, owner, or next_step changed
      const was = { status: t.status, owner: t.owner, next_step: t.next_step };
      for (const k of ['owner', 'next_step']) {
        if (a[k] === undefined) continue;
        const v = String(a[k]).trim();
        if (!v) return err(`Rejected: ${k} cannot be emptied. A task without ${k} is a wish, not a task — close it instead.`);
        // hades N2 2026-08-09: editing next_step after delegating was accepted and then
        // silently reverted by task_ack — the recipient never learns the ask changed.
        // That is precisely what task_delegate's own description condemns: recording your
        // belief about their work where they cannot see it. Refuse instead of pretending.
        if (k === 'next_step' && t.delegated && !t.delegated.acked)
          return err(`Rejected: #${t.id} is delegated to ${t.delegated.to} and not yet acknowledged. ` +
                     `Changing next_step here would change what YOU see and nothing they see — ` +
                     `they were asked: "${t.delegated.ask}". Re-delegate with the new ask ` +
                     `(task_delegate replaces:${t.id}), or wait for their reply.`);
        if (k === 'next_step' && isWaiting(v) &&
            !(a.blocked_on?.trim() || t.blocked_on))
          return err(`Rejected: next_step "${v}" describes waiting — set blocked_on to name who.`);
        if (k === 'next_step' && isFiller(v))
          return err(`Rejected: next_step "${v}" is filler, not an action. ` +
                     `Write what you would actually do next.`);
        t[k] = v;
      }
      if (a.blocked_on !== undefined) {
        // ⭐ ebola 2026-08-09: blocked_on was the cheapest whitewash in the whole tool —
        // one unvalidated free-text field that removed a task from NOTHING STARTED's
        // population AND refreshed `updated`, killing UNTOUCHED 7+ DAYS in the same write.
        // Eight calls, no thinking, and a completely stalled list reports healthy.
        // 🔑 And it is the SAME SHAPE I had already fixed one lane over: ageing a state
        // from a timestamp the state's own writer controls (F4, delegated.sent). I
        // recognised it for acks and left it untouched here.
        // blocked_since is set only on the null → value transition, so re-writing
        // blocked_on cannot reset how long this has been blocked.
        const wasBlocked = !!t.blocked_on;
        const willBlock = !!(a.blocked_on && a.blocked_on.trim());
        if (!wasBlocked && willBlock) t.blocked_since = nowISO();
        if (!willBlock) t.blocked_since = null;
        // Same constraint on the update path — F-class defect ebola found was exactly
        // a gate that existed only on create.
        if (looksLikePerson(a.blocked_on) && !t.delegated)
          return err(`Rejected: blocked_on "${a.blocked_on.trim()}" names a person and #${t.id} was ` +
                     `never delegated. Use task_delegate — writing their name here does not tell them.`);
        t.blocked_on = a.blocked_on.trim() || null;
      }
      t.updated = nowISO();
      // Setting blocked_on is deliberately NOT progress — that was the whitewash. Nor is
      // a call that changed nothing at all.
      if (t.status !== was.status || t.owner !== was.owner || t.next_step !== was.next_step)
        t.progressed = t.updated;
      return { ok: true, task: t };
    },
  },

  task_list: {
    annotations: { title: 'List tasks', readOnlyHint: true, destructiveHint: false },
    description:
      'List tasks. Defaults to open work only (triage/todo/doing). Use ' +
      '`stale_days` to surface tasks opened and then never touched — that is ' +
      'the failure mode this kind of list always has.',
    schema: {
      type: 'object',
      properties: {
        status:     { type: 'string', enum: [...STATES, 'open'] },
        owner:      { type: 'string' },
        blocked:    { type: 'boolean', description: 'Only tasks waiting on something.' },
        stale_days: { type: 'number', description: 'Only tasks untouched for at least N days.' },
      },
    },
    run(db, a) {
      let ts = db.tasks;
      const st = a.status || 'open';
      ts = st === 'open' ? ts.filter((t) => OPEN.includes(t.status)) : ts.filter((t) => t.status === st);
      if (a.owner)   ts = ts.filter((t) => t.owner === a.owner);
      if (a.blocked) ts = ts.filter((t) => t.blocked_on);
      if (a.stale_days) ts = ts.filter((t) => days(t.updated) >= a.stale_days);
      // An empty store is the one state that is self-perpetuating: 0 tasks means the
      // daily sweep finds nothing, exits 0, and never contacts you — so the agent who
      // has not started is precisely the one nothing will ever prompt. Measured
      // 2026-08-10: 5 of 7 stores sat at 0. This is the moment they are looking, so
      // it is the moment to say what to do, rather than return a bare empty list.
      if (db.tasks.length === 0)
        return {
          count: 0, wip: `0/${db.wip_limit}`, tasks: [],
          getting_started:
            'This store is empty, so nothing here will ever prompt you — the daily ' +
            'stall sweep has nothing to find and stays silent. This is the durable, ' +
            'inspectable list, so it is the one that should be complete: bring your ' +
            'real open work in via task_add. Each item needs an owner and a concrete ' +
            'next step (that gate is what keeps the list from rotting — it is not a ' +
            'formality, and "review it" is not a next step). The WIP cap limits how ' +
            'many you may have in `doing` at once, not how many you may hold. After ' +
            'that, run task_list at the start of each session before taking on ' +
            'anything new.',
        };
      return {
        count: ts.length,
        wip: `${db.tasks.filter((t) => t.status === 'doing').length}/${db.wip_limit}`,
        tasks: ts.map((t) => ({
          id: t.id, status: t.status, title: t.title, owner: t.owner,
          next_step: t.next_step, blocked_on: t.blocked_on,
          stale_days: Math.floor(days(t.updated)), rolled: t.rolled,
          // F1: without this, a delegation that was accepted and one nobody ever saw
          // render identically — one view cannot express two opposite states.
          ...(t.delegated ? { delegation: {
            to: t.delegated.to,
            // hades N1 2026-08-09: this used to read only `response`, so an evidenced ack
            // and one I simply typed rendered identically here. The F1 fix — surfacing
            // delegation in task_list — had become the new hiding place for F4. A field
            // added to end concealment must itself be checked for what it conceals.
            state: !t.delegated.acked ? 'UNACKNOWLEDGED'
                 : `${t.delegated.response || 'acked'} (${t.delegated.ack_source || 'self-asserted'})`,
            ack_source: t.delegated.ack_source || null,
            waiting_days: Math.floor(days(t.delegated.sent)),
          } } : {}),
        })),
      };
    },
  },

  task_triage: {
    annotations: { title: 'Triage an inbox item', readOnlyHint: false, destructiveHint: true },
    description:
      'Resolve an item sitting in triage: accept (into todo), decline ' +
      '(requires a reason), duplicate (fold into an existing task), or snooze ' +
      '(requires days). Unresolved items stay in triage and keep showing up — ' +
      'that is intentional.',
    schema: {
      type: 'object',
      properties: {
        id:     { type: 'number' },
        action: { type: 'string', enum: ['accept', 'decline', 'duplicate', 'snooze'] },
        reason: { type: 'string' },
        into:   { type: 'number', description: 'Target task id when action is duplicate.' },
        days:   { type: 'number', description: 'Days to snooze.' },
      },
      required: ['id', 'action'],
    },
    run(db, a) {
      const t = find(db, a.id);
      if (!t) return err(`No task #${a.id}.`);
      if (t.status !== 'triage') return err(`#${a.id} is not in triage (currently ${t.status}).`);
      switch (a.action) {
        case 'accept': t.status = 'todo'; break;
        case 'decline':
          if (!a.reason?.trim()) return err('Rejected: decline requires a reason.');
          t.status = 'dropped'; t.closed_reason = `declined: ${a.reason.trim()}`; break;
        case 'duplicate': {
          const into = find(db, a.into);
          if (!into) return err('Rejected: duplicate requires an existing `into` task id.');
          t.status = 'dropped'; t.closed_reason = `duplicate of #${into.id}`; break;
        }
        case 'snooze':
          if (!a.days) return err('Rejected: snooze requires days.');
          t.snooze_until = new Date(Date.now() + a.days * 86400000).toISOString(); break;
      }
      t.updated = nowISO();
      return { ok: true, task: t };
    },
  },

task_delegate: {
    annotations: { title: 'Delegate a task to someone else', readOnlyHint: false, destructiveHint: false },
    description:
      'Hand a task to another agent or person. This does two things that must both ' +
      'succeed: it hands the request to the configured transport, and only then ' +
      'records it locally as awaiting their acknowledgement. If the send fails, no ' +
      'ticket is created — a delegation nobody received is not a delegation. Use this ' +
      'instead of writing their name into blocked_on, which records your belief about ' +
      'their work in a place they cannot see.',
    schema: {
      type: 'object',
      properties: {
        to:        { type: 'string', description: 'Who you are handing it to.' },
        title:     { type: 'string', description: 'One line: what you need from them.' },
        next_step: { type: 'string', description: 'The first concrete action THEY should take.' },
        note:      { type: 'string', description: 'Context they need in order to start.' },
        replaces:  { type: 'number', description: 'Ticket id this supersedes — required when re-delegating work that came back declined, so the same work is not open twice.' },
      },
      required: ['to', 'title', 'next_step'],
    },
    run(db, a) {
      if (!a.to?.trim())        return err('Rejected: no recipient.');
      // F5 (hades): re-delegating after a decline used to mint an unrelated second
      // ticket, so one piece of work sat open twice with nothing linking them and
      // nobody closing either. Require the caller to say which one this replaces.
      let prev = null;
      if (a.replaces !== undefined) {
        prev = find(db, a.replaces);
        if (!prev) return err(`Rejected: replaces #${a.replaces} does not exist.`);
        if (!prev.delegated) return err(`Rejected: #${a.replaces} was never delegated.`);
        prev.status = 'dropped';
        prev.closed_reason = `re-delegated to ${a.to.trim()}`;
        prev.updated = nowISO();
      }
      if (!a.title?.trim())     return err('Rejected: title is empty.');
      if (!a.next_step?.trim()) return err('Rejected: no next_step. Do not hand someone a topic.');
      if (isFiller(a.next_step))
        return err(`Rejected: next_step "${a.next_step.trim()}" is filler. You are asking someone ` +
                   `else to act — be specific about what.`);
      // A waiting-shaped step is what you are trying to ESCAPE by delegating.
      if (isWaiting(a.next_step))
        return err(`Rejected: next_step "${a.next_step.trim()}" describes waiting. You are the one ` +
                   `delegating; say what they should DO.`);

      const t = {
        id: ++db.seq, title: a.title.trim(), owner: CTX.agent,
        next_step: `awaiting ${a.to.trim()}: ${a.next_step.trim()}`,
        status: 'todo', source: null, blocked_on: a.to.trim(),
        // ⭐ hades 2026-08-09: this path sets blocked_on automatically and was the ONLY
        // writer that omitted blocked_since — so the one ticket type guaranteed to be
        // blocked was the only one immune to BLOCKED FOR 14+ DAYS. The gate I added
        // because "blocked_on is the cheapest whitewash" did not cover the blocked_on
        // this tool writes for you. Measured: delegate-created, 30 days old → silent;
        // add this one field and nothing else → it fires.
        blocked_since: nowISO(),
        // ebola 2026-08-09: a specimen and an instance are byte-identical. The example
        // payload in my own spec document satisfied every rule a drain would apply —
        // so merely sending that document over the transport would have manufactured an
        // ack for a live delegation. That needs no malice at all: an honest review, a
        // pasted example, a forwarded file.
        // The nonce is the part a specimen cannot carry — minted here, valid for this
        // delegation only. A pasted example holds a placeholder or a dead value.
        // ⚠️ It does NOT stop deliberate forgery: this side mints it, so this side can
        // replay it. It kills accidental contamination, which is a different class.
        delegated: { to: a.to.trim(), sent: nowISO(), acked: null, ask: a.next_step.trim(),
                     nonce: randomBytes(9).toString('base64url') },
        cycle: db.cycle.n,
        // 🔴 hades 2026-08-09 + sibling found at the repair moment: re-delegation was a
        // LAUNDERING path. `rolled` counts cycles survived without finishing, and anything
        // rolled 3+ times gets escalated as "this will not finish on its own". Minting the
        // replacement at rolled:0 reset that counter — so work could evade escalation
        // forever by being re-delegated. `created` reset the same way, hiding true age from
        // the staleness checks. Both now carry forward from the ticket being replaced.
        // `progressed` is stamped now because re-delegating IS an action — the work is old,
        // but it is not sitting still. Those are two different facts and the store keeps both.
        rolled:  prev ? prev.rolled  : 0,
        created: prev ? prev.created : nowISO(),
        progressed: nowISO(),
        updated: nowISO(), closed_reason: null,
        replaces: a.replaces ?? null,
      };
      const payload = JSON.stringify({
        from: CTX.agent, to: t.delegated.to, ref: t.id, title: t.title,
        next_step: t.delegated.ask, note: a.note || null, sent: t.delegated.sent,
        nonce: t.delegated.nonce,
      });

      // The send must happen BEFORE the ticket exists. The whole point is that a
      // delegation which never left this machine must not be able to sit in the list
      // looking tracked — that is the failure this tool was built to stop, and putting
      // the record first would rebuild it.
      const cmd = resolveSendCmd();
      // ⚠️ hades 2026-08-09 (F3): exit 0 only means the transport did not report failure.
      // A fire-and-forget transport succeeds at doing nothing and still returns 0, so this
      // cannot prove delivery — nothing on the sending side can. The unacknowledged sweep
      // is the compensating control, which is why F2 had to be built before this is tolerable.
      if (!cmd)
        return err(
          'Rejected: no send command is configured, so this instance cannot deliver anything.\n' +
          'One is needed: an executable that reads ONE JSON object on stdin and actually sends it.\n' +
          'Two ways, and on a shared machine the first is usually the right one:\n' +
          '  (a) put it at ~/.guanling/send (chmod +x). Every agent on this machine picks it\n' +
          '      up with no per-agent config — which matters, because requiring each agent to\n' +
          '      edit its own .mcp.json leaves delegation off for everyone who did not know to.\n' +
          '  (b) set GUANLING_SEND_CMD in the env block of the .mcp.json that launches THIS\n' +
          '      server, when you want it for this one agent only, e.g.\n' +
          '        "tasks": { "command": "node", "args": ["...server.mjs"],\n' +
          '                   "env": { "GUANLING_SEND_CMD": "/home/you/bin/guanling-send" } }\n' +
          'The stdin JSON is {from,to,ref,title,next_step,note,sent,nonce} — your script decides the\n' +
          'transport. ⚠️ It MUST put `nonce` verbatim into the message it sends: task_drain matches a\n' +
          "reply by finding that string in it, so a formatter that drops it makes every drain fail.\n" +
          'No send command? Then send the request yourself and use task_add instead. Do not record ' +
          'a delegation that was never sent.');
      try {
        execFileSync(cmd, [], { input: payload, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return err(`Rejected: delivery failed (${e.code || e.message}). No ticket was created — ` +
                   `a delegation nobody received is not a delegation.`);
      }
      // Outbox is an audit trail, not the transport. Written only after a successful send.
      try { appendFileSync(`${dirname(CTX.file)}/outbox.jsonl`, payload + '\n'); }
      catch (e) { console.error(`[guanling] outbox write failed: ${e.message}`); }  // 2026-08-10 黑帝斯抓到：
      // 原本寫 `dirname(FILE)`，而 FILE 在整支檔案沒有宣告 ⇒ 每次都 ReferenceError ⇒ 被空的 catch 吞掉。
      // 🩸 是我昨天把 FILE 改名成 CTX.file 時漏掉這一行，而 `catch {}` 讓那個 regression 完全無聲。
      // ⚠️ 實際不是「從未寫過」：outbox 有 3 筆、最後一筆 08-09 17:47 ⇒ 它【曾經是對的】，之後才壞。
      //    ⇒ 一個宣稱自己是稽核軌跡的東西，靜默地停止記錄——而你只有在需要查證時才會發現。
      //    ∴ catch 改成出聲：稽核軌跡寫不進去，本身就是要被知道的事。

      db.tasks.push(t);
      return { ok: true, id: t.id, delegated_to: t.delegated.to,
               note: 'Handed to the transport and recorded as awaiting acknowledgement. ' +
                     'Handed off is not the same as read or accepted — only task_ack means ' +
                     'they took it, and the sweep chases anything still unacknowledged.' };
    },
  },

  task_ack: {
    annotations: { title: 'Record that a delegate responded', readOnlyHint: false, destructiveHint: false },
    description:
      'Record that the person you delegated to actually responded. Accepting closes ' +
      'the acknowledgement gap; declining returns the task to you with their reason, ' +
      'because work handed over and refused must come back visible rather than vanish.',
    schema: {
      type: 'object',
      properties: {
        id:       { type: 'number' },
        response: { type: 'string', enum: ['accepted', 'declined'] },
        reason:   { type: 'string', description: 'Required when declined — their reason, not yours.' },
        nonce:    { type: 'string', description: 'The nonce echoed back in their reply. Required alongside evidence — it is the part a pasted specimen cannot carry.' },
        evidence: { type: 'string', description: 'Where their reply actually is — a message id, a transcript reference, anything a third party could go and read. Without it the ack is recorded as self-asserted and the sweep keeps watching, because "I marked it accepted" is not the same as "they accepted".' },
      },
      required: ['id', 'response'],
    },
    run(db, a) {
      const t = find(db, a.id);
      if (!t) return err(`No task #${a.id}.`);
      if (!t.delegated) return err(`#${a.id} was never delegated — nothing to acknowledge.`);
      if (t.delegated.acked) return err(`#${a.id} was already acknowledged at ${t.delegated.acked}.`);
      if (a.response === 'declined' && !a.reason?.trim())
        return err('Rejected: a decline needs their reason. "They said no" is not a reason.');
      // ⚠️ hades 2026-08-09 (F4): this used to also refresh t.updated, which is the ONLY
      // staleness clock. So a one-sided ack did not merely go unverified — it silently
      // pushed back the single alarm that would have surfaced it. The delegation ages
      // from delegated.sent, which nothing but a real reply should ever reset.
      // 🔑 An ack with no evidence is an assertion by the sender about the recipient.
      // Recording both under one field is what let a one-sided ack look like a reply
      // (hades F4). They are now different states, and only the evidenced one stops
      // the sweep — so marking it yourself no longer buys silence.
      t.delegated.acked = nowISO();
      t.delegated.response = a.response;
      t.delegated.evidence = a.evidence?.trim() || null;
      // An evidenced ack must carry the nonce this delegation was minted with. Without
      // that, "evidenced" degrades to "a string was supplied", and a specimen supplies
      // strings just as well as a reply does.
      const echoed = a.nonce?.trim();
      const nonceOk = !t.delegated.nonce || (echoed && echoed === t.delegated.nonce);
      if (a.evidence?.trim() && !nonceOk)
        return err(`Rejected: evidence given but the nonce does not match this delegation. ` +
                   `Either the reply is for a different one, or what you are looking at is a ` +
                   `copy of a message rather than the reply itself.`);
      t.delegated.ack_source = (a.evidence?.trim() && nonceOk) ? 'evidenced' : 'self-asserted';
      if (a.response === 'accepted') {
        // F1: after acceptance the wait changes meaning — from "did it arrive" to
        // "is it done". Same word, different failure, different timescale.
        t.next_step = `accepted by ${t.delegated.to} — waiting for it to be DONE (was: waiting to be received): ${t.delegated.ask}`;
      }
      if (a.response === 'declined') {
        // ⭐ hades 2026-08-09, and he was explicit that it harms nothing TODAY: every
        // other writer keeps blocked_on and blocked_since alive-or-dead together
        // (task_add, both task_update branches) — this was the one place that cleared
        // one and kept the other, leaving an open ticket with no blocker but a blocker
        // age. Nothing reads it yet, so the cost is purely future: the next check that
        // keys on blocked_since ALONE would read a stale age off a declined ticket.
        // Closing an invariant break while it is still free is the whole point.
        t.blocked_on = null;
        t.blocked_since = null;
        t.delegated.decline_reason = a.reason.trim();
        t.next_step = `came back declined (${a.reason.trim()}) — decide: do it yourself, or drop it`;
      }
      t.updated = nowISO();
      return { ok: true, task: t,
               note: t.delegated.ack_source === 'evidenced'
                 ? 'Recorded with evidence — the sweep will stop watching this one.'
                 : 'Recorded as SELF-ASSERTED (no evidence given). The sweep keeps watching it: ' +
                   'you saying they accepted is not the same as them accepting. Pass `evidence` ' +
                   'once you have something a third party could go and read.' };
    },
  },

  task_drain: {
    annotations: { title: "File a delegate's reply against the right ticket", readOnlyHint: false, destructiveHint: false },
    description:
      "Paste a delegate's reply verbatim; this finds which delegation it answers (by the nonce " +
      'the reply carries) and records the acknowledgement. Use this instead of task_ack whenever ' +
      'you actually have the reply in front of you — it removes the step where you look up the ' +
      'ticket id yourself, which is the step that gets skipped.\n\n' +
      'It refuses a reply carrying no live nonce. That is the point: a message with no nonce is ' +
      'not distinguishable from a forwarded copy, an example, or a reply to something else.',
    schema: {
      type: 'object',
      properties: {
        reply:    { type: 'string', description: "The delegate's reply, pasted as received. Must contain the nonce." },
        response: { type: 'string', enum: ['accepted', 'declined'] },
        reason:   { type: 'string', description: 'Required when declined — their reason, not yours.' },
        evidence: { type: 'string', description: 'Where the reply is — message id, transcript ref. Required here: if you can paste it, you can say where it came from.' },
      },
      required: ['reply', 'response', 'evidence'],
    },
    // 🔑 這是關令一直缺的那一半（2026-08-09）：委派送得出去，回覆卻沒有東西歸檔 ——
    //   要靠人記得回來按 task_ack，而「需要你記得」正是它輸給內建半殘清單的原因。
    //   本工具不新增任何判準：找到 ticket 之後【原封呼叫 task_ack.run】，
    //   所以 nonce/證據/時鐘/declined 清 blocked_* 那些規則全部沿用，不會出現第二套。
    // ⚠️ 不做的兩件事，都是刻意的：
    //   ① 不自動判 accepted/declined —— 那是分類，而分類錯比多問一句貴。
    //   ② 不從 reply 猜 evidence —— 「你貼得出來就說得出它在哪」，讓出處由人給。
    // ⓪ 這裡【沒有】循環論證：nonce 來自 a.reply（外部輸入），不是從 ticket 讀出來再拿去比對它自己。
    //   下游 task_ack 的 nonce 檢查在這條路徑上必然通過 —— 因為證明已經在上游完成了。
    run(db, a) {
      const reply = (a.reply || '').trim();
      if (!reply) return err('Rejected: reply is empty. There is nothing to file.');
      if (!a.evidence?.trim())
        return err('Rejected: no evidence. You are holding the reply — say where it is ' +
                   '(message id / transcript ref) so a third party could go and read it.');
      const live = db.tasks.filter((t) => t.delegated && !t.delegated.acked && t.delegated.nonce);
      const hits = live.filter((t) => reply.includes(t.delegated.nonce));
      if (hits.length === 0 && live.length === 0)
        return err('Rejected: there are no open delegations at all — nothing is waiting to be ' +
                   'filed. This is not a matching failure: task_drain has nothing to match ' +
                   'against. If you delegated from another machine or another store, file it ' +
                   'there. (天天 2026-08-10: the old text sent people to re-paste, when the real ' +
                   'answer is that there is nothing to drain.)');
      if (hits.length === 0 && /\bgl-[A-Za-z0-9]{4,}\b/.test(reply))
        return err(`Rejected: this reply carries a nonce, but it matches none of the ` +
                   `${live.length} delegation(s) still awaiting acknowledgement. That is a ` +
                   `different problem from carrying no nonce at all: you are probably holding ` +
                   `the reply to something already filed, or a reply from a different store. ` +
                   `Check the id before re-pasting. (天天 2026-08-10: these two used to return ` +
                   `the same sentence, and they have different next steps.)`);
      if (hits.length === 0)
        return err(`Rejected: this reply carries no nonce belonging to any unacknowledged ` +
                   `delegation (${live.length} currently waiting). Either it answers something ` +
                   `already filed, or it is not the reply itself — a forward, a paste, or an ` +
                   `example carries the words but not the nonce. If you are certain, use ` +
                   `task_ack with the id and no evidence: it will be recorded as SELF-ASSERTED.`);
      if (hits.length > 1)
        return err(`Rejected: the reply matches ${hits.length} delegations (#${hits.map((t) => t.id).join(', #')}). ` +
                   `Refusing to guess which one — file them one at a time with task_ack.`);
      const t = hits[0];
      const out = TOOLS.task_ack.run(db, {
        id: t.id, response: a.response, reason: a.reason,
        evidence: a.evidence, nonce: t.delegated.nonce,
      });
      if (out?.error) return out;
      return { ...out, matched_by: 'nonce carried in the reply', id: t.id, title: t.title,
               note: (out.note || '') + ' Matched from the reply text — you did not have to know the id.' };
    },
  },

  cycle_status: {
    annotations: { title: 'Cycle status', readOnlyHint: true, destructiveHint: false },
    description: 'Days left in the current cycle, WIP usage, and tasks that have gone stale.',
    schema: { type: 'object', properties: {} },
    run(db) {
      const elapsed = days(db.cycle.start);
      const open = db.tasks.filter((t) => OPEN.includes(t.status));
      const stale = open.filter((t) => days(t.updated) >= 7);
      const rolled = open.filter((t) => t.rolled >= 2);
      return {
        cycle: db.cycle.n,
        days_elapsed: Math.floor(elapsed),
        days_left: Math.max(0, Math.ceil(db.cycle.days - elapsed)),
        wip: `${db.tasks.filter((t) => t.status === 'doing').length}/${db.wip_limit}`,
        open: open.length,
        // 🔴 2026-08-12 — `open` 一直只是個數字，沒有任何閘在看它。
        //    實測我自己：wip 2/6（綠燈）、open 137。而本工具開宗明義寫的是
        //    「只放有人在等的事；變長就是它壞了」。
        // 📏 有閘的軸是「同時做幾件」(doing)，沒閘的軸是「答應了幾件」—— 後者才是它存在的理由。
        //    ⇒ 不引進新的魔術數：門檻從既有的 wip_limit 推導（×5），過了就出聲。
        //    ⚠️ 這一格第一個擋到的是我自己（137 筆）。那正是它該有的樣子 ——
        //       一個放過提案者自己的規則，讀起來會跟一個好主意一模一樣。
        open_verdict: open.length > db.wip_limit * 5
          ? `🔴 open=${open.length} 超過 ${db.wip_limit * 5}（wip_limit×5）。這已經不是承諾清單、是第二本記錄本 —— 先 task_triage／task_update(done) 收掉，別再 task_add。`
          : 'ok',
        // 🔴 原本直接印 stale.length。公式本身是對的（量 t.updated，且 cycle_roll 只改
        //    rolled/cycle、不重寫 updated —— 讀碼確認過）。錯的是另一件事：
        //    週期還不滿 7 天時它【必然】是 0，而那個 0 跟「查過、沒有」在畫面上完全相同。
        // 📏 「還測不到」與「測了是零」共用同一個字面值 ⇒ 前者一定會被讀成後者。
        stale_7d: elapsed < 7 ? null : stale.length,
        stale_7d_note: elapsed < 7
          ? `尚不可測：本週期才 ${Math.floor(elapsed)} 天，任何任務都不可能滿 7 天。null ≠ 0。`
          : undefined,
        // Rolled twice and still not done: it probably never will be. This field
        // exists to force a decision, not to report a number.
        rolled_twice_plus: rolled.map((t) => ({ id: t.id, title: t.title, rolled: t.rolled })),
      };
    },
  },

  cycle_roll: {
    annotations: { title: 'Roll the cycle forward', readOnlyHint: false, destructiveHint: true },
    description:
      'Close the current cycle and open the next. Unfinished work carries over ' +
      'with its `rolled` count incremented. Anything rolled 3+ times is returned ' +
      'separately as needing a decision — it is never dropped silently. Items ' +
      'still in triage do not roll forward; they stay at the gate.',
    schema: { type: 'object', properties: { days: { type: 'number', description: 'Length of the next cycle in days.' } } },
    run(db, a) {
      const carried = [];
      for (const t of db.tasks) {
        if (!OPEN.includes(t.status)) continue;
        if (t.status === 'triage') continue;   // untriaged work stays at the gate
        t.rolled += 1; t.cycle = db.cycle.n + 1;
        carried.push({ id: t.id, title: t.title, rolled: t.rolled });
      }
      db.cycle = { n: db.cycle.n + 1, start: nowISO(), days: a.days || db.cycle.days };
      const nag = carried.filter((c) => c.rolled >= 3);
      return {
        ok: true, new_cycle: db.cycle.n, carried: carried.length,
        needs_decision: nag,
        note: nag.length
          ? `${nag.length} task(s) have rolled 3+ times. They will not finish on their own — close them or reassign.`
          : undefined,
      };
    },
  },
};

// ─────────── Protocol dispatch — transport-independent, per the MCP spec ───────────
// "Protocol semantics are identical on every transport. A transport is a binding."
// So dispatch() returns a response object and knows nothing about how it travels;
// the stdio loop below writes it to stdout, http.mjs writes it to an HTTP response.
// This split is the whole reason one server can serve many clients — there is no
// second implementation to keep in sync, which is the defect class hades caught me
// on twice today (one rule, two copies, no signal on the day they diverge).
export function dispatch(req) {
  // ⭐ hades 2026-08-09 F3, and this is the best thing either review produced:
  // I pinned the invariant to the WRONG NOUN. I guarded "this file contains no
  // async/await" — but async/await is only ONE way to create a yield point.
  // setTimeout, setImmediate, process.nextTick, queueMicrotask, a .then() callback:
  // any of them would let request B change the identity while A is suspended, and my
  // grep would happily pass.
  //   Enumerating the bad ways is a whitelist, and a whitelist's default is ALLOW.
  //   Asserting the good property costs one string compare and does not care how the
  //   yield happened.
  // 🔑 He also noted req.on('end', …) is itself an async callback — the safety comes
  //    from the event loop serialising callbacks, NOT from the absence of `async`.
  //    My conclusion was right and the reason I wrote down was narrower than the
  //    mechanism, which is exactly how a guard ends up admitting what it was built
  //    to stop.
  // This closes his F1 too: if identity is swapped underneath us, this throws.
  //
  // ⚠️ SCOPE, in hades's words and kept here on purpose: this is a DETECTOR, not a
  // preventer. It throws AFTER the write, and the error text says so — "the write you
  // just made may have landed in the wrong agent's store". The direction is right
  // (silence becomes noise) but that write already happened. It is not a barrier.
  // 🔑 Recorded here because he said it in a relay message, and nobody reads a relay
  //    message twice. A caveat that lives only in a conversation is not a caveat.
  const agentAtEntry = CTX.agent;
  const out = dispatchInner(req);
  if (CTX.agent !== agentAtEntry)
    throw new Error(
      `guanling: identity changed mid-dispatch (${agentAtEntry} → ${CTX.agent}). ` +
      `Something yielded between enterRequest() and the end of this call; the write ` +
      `you just made may have landed in the wrong agent's store.`);
  return out;
}

// ⭐ 2026-08-10, Robert: "the package should tell you how to use it, instead of you
// having to go ask qimenzi." ebola had to message me to learn the daily loop — and
// that message DEMONSTRATED the defect rather than fixing it: a freshly installed
// agent has no one to ask. Measured consequence: 5 of 7 task files sat at 0 tasks,
// and an empty file is permanently silent (0 tasks → the nag sweep exits 0 → the one
// scheduled thing that could reach you cannot, by construction, reach someone who
// has not started).
//
// 🔑 ebola's constraint, and it is the whole design spec here:
//   "An agent's onboarding surface is the tool list, the tool descriptions, and the
//    refusal messages. There is no fourth place. A document nothing pulls into
//    context does not exist."
//   Evidence: README.md existed the whole time. ebola read this folder, ran the
//   tests, wrote a report — and never opened it, because nothing put it in front of
//   them. So this text lives in `instructions`, the one field the client injects
//   into every session before any tool is called.
// GUANLING_SEND_CMD wins. Failing that, look for a conventional local hook at
// ~/.guanling/send (must be executable).
// 🔑 Why the fallback exists: the package has to stay transport-agnostic — "send" means
//    a different thing on every machine, so hard-coding one into a generic tool is the
//    wrong coupling. But requiring an env block in EVERY agent's .mcp.json means that on
//    a shared machine delegation stays off for everyone who didn't know to add it, and
//    "off for everyone by default" is how a third of the tools ended up dead.
//    One executable at a known path turns it on for every agent on the box, with no
//    per-agent config and no transport knowledge inside the package.
// ⚠️ Deliberately requires the executable bit rather than mere existence: a non-executable
//    file there would fail at spawn time, i.e. at delegation time, which is the worst
//    possible moment to discover it. Absent or not-executable both read as "off", and
//    the instructions then say so up front.
function resolveSendCmd() {
  const env = (process.env.GUANLING_SEND_CMD || '').trim();
  if (env) return env;
  try {
    const hook = join(homedir(), '.guanling', 'send');
    accessSync(hook, FS.X_OK);
    return hook;
  } catch { return ''; }
}

function instructions() {
  const canDelegate = !!resolveSendCmd();
  return [
    `You are "${CTX.agent}" here; this store is yours alone and no other agent can see it.`,
    ``,
    `WHAT THIS IS FOR. This is the DURABLE list — the one that outlives your session,`,
    `that your operator can inspect on disk, that the daily sweep chases when it goes`,
    `stale, and that records who a thing was handed to. Whatever scratchpad your harness`,
    `gives you is per-session and nobody can audit it.`,
    `⇒ So THIS is the list that should be COMPLETE. If real work lives only in the`,
    `scratchpad, it is untracked: no sweep, no owner, no visibility.`,
    ``,
    `(Corrected 2026-08-10 by the owner. This text used to say the opposite — keep this`,
    `short and let your other list hold everything. That was backwards: dropping an item`,
    `from here moves it from a tracked place to an untracked one. The author had pruned`,
    `the disciplined list and preserved the rotting one.)`,
    ``,
    `THE LIMIT IS ON CONCURRENCY, NOT ON SIZE. The WIP cap of ${WIP_DEFAULT} applies to`,
    `\`doing\` — how many things you may have in flight at once. It says nothing about how`,
    `many \`todo\` items you may hold. Thirty waiting items with three in flight is the`,
    `system working, not a violation.`,
    ``,
    `WHAT KEEPS IT FROM ROTTING is the gate, not the size: every task is refused without`,
    `an owner and a concrete next step. That is what stops a list becoming 280 rows of`,
    `wishes. So bringing existing work in is fine and usually right — but each item has`,
    `to earn its way through that gate, which means writing the real next action.`,
    ``,
    `⚠️ \`dropped\` means "this is genuinely no longer work". It does NOT mean "nobody is`,
    `waiting on it right now" — unwatched work is exactly what you most need tracked.`,
    ``,
    `THE DAILY LOOP — three actions, and this is the part nobody guesses:`,
    `  1. Start of session: task_list — see what you already owe. Do this before`,
    `     picking up anything new.`,
    `  2. The moment you accept work someone is waiting on: task_add. Not later.`,
    `     Later never comes, and the sweep cannot remind you of a task you never wrote.`,
    `  3. When you finish or hand it off: task_update (done) or task_delegate.`,
    `Weekly-ish: cycle_status for what is stale and how much of the cycle is left.`,
    ``,
    canDelegate
      ? `DELEGATION IS ON. task_delegate sends via GUANLING_SEND_CMD; paste the reply`
        + ` into task_drain to close the loop.`
      // 🩸 伊波拉 2026-08-10：這段原本只講 env 那條路，而碼早就支援兩條。
      //    一個讀到 OFF 的 agent 會以為唯一解是「請人改我的 .mcp.json」——
      //    而正解通常是「這台機器放一支可執行檔，全部 agent 一起開」。
      //    📏 碼實作了新結論，教學文字還停在被取代的舊做法 —— 而文字才是 agent 讀到的那一份。
      : `DELEGATION IS OFF on this install, so task_delegate will refuse (it will not`
        + ` silently pretend to send). Everything else works — treat delegate/ack/drain as`
        + ` unavailable and do not burn time debugging it. Turning it on is an OPERATOR`
        + ` task, either way: (a) put an executable at ~/.guanling/send — on a shared`
        + ` machine this enables it for EVERY agent at once, which is usually what you`
        + ` want; or (b) set GUANLING_SEND_CMD in this one server's env for just this`
        + ` agent. Either must read ONE JSON object on stdin and actually deliver it.`,
  ].join('\n');
}

function dispatchInner(req) {
  const { id, method, params } = req;
  if (method === 'initialize')
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: `guanling-${CTX.agent}`, version: VERSION },
      instructions: instructions(),
    }};
  if (method === 'notifications/initialized') return null;   // notification: no reply
  if (method === 'tools/list')
    return { jsonrpc: '2.0', id, result: {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name, title: t.annotations.title, description: t.description,
        inputSchema: t.schema, annotations: t.annotations })),
    }};
  if (method === 'tools/call') {
    const t = TOOLS[params?.name];
    if (!t) return { jsonrpc: '2.0', id, error: { code: -32601, message: `no tool ${params?.name}` } };
    let out;
    try {
      const db = load();
      out = t.run(db, params.arguments || {});
      if (!out?.error) save(db);      // only successful calls persist; refusals leave no trace
    } catch (e) {
      out = { error: `${e.name}: ${e.message}` };
    }
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: !!out?.error,
    }};
  }
  if (id !== undefined)
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `no method ${method}` } };
  return null;
}

// ─────────────────────── stdio binding ───────────────────────
// Only runs when this file is the entrypoint. Imported by http.mjs, it must NOT
// grab stdin — otherwise the HTTP server would sit there consuming its own stdin
// and the two bindings would fight over one stream.
const send = (o) => { if (o) process.stdout.write(JSON.stringify(o) + '\n'); };

// ─────────────────── 甲：plugin 自己把排程帶起來 ───────────────────
// Robert 2026-08-10「他們要一套的阿」—— 他是對的：一個東西要裝兩個地方就是爛設計。
// 而有一個繞不過的限制：**排程需要一個一直活著的行程，而 MCP plugin 是跟著 session 生死的。**
// ⇒ 所以「一套」不是把排程塞進 plugin（做不到），是【裝 plugin 就會把排程帶起來】。
//
// race：十幾個 agent 同時開 session ⇒ 十幾個人同時 spawn ⇒ 但 listen 只有一個成功，
//       其餘在 http.mjs 的 EADDRINUSE 分支安靜 exit(0)。**互斥由核心保證，這裡不需要鎖。**
// ⚠️ 這裡故意【不等、不擋、不拋】：排程起不來也絕不能讓工具本身壞掉。
function ensureScheduler() {
  try {
    // 裝了 plugin 就會多一個常駐行程 —— 給不想要的人一個關法，別讓它是強制的
    if (process.env.GUANLING_NO_SCHEDULER === '1') return;
    const HERE = dirname(fileURLToPath(import.meta.url));
    const PORT = Number(process.env.GUANLING_PORT || 4620);
    const probe = createConnection({ host: '127.0.0.1', port: PORT });
    probe.setTimeout(700);
    const giveUp = () => { try { probe.destroy(); } catch {} };
    probe.on('connect', () => { giveUp(); });            // 已經有人在跑 → 什麼都不用做
    probe.on('timeout', giveUp);
    probe.on('error', () => {                            // 連不上 ⇒ 沒人在跑 ⇒ 拉起來
      try {
        const dir = join(homedir(), '.guanling');
        mkdirSync(dir, { recursive: true });          // 首次安裝時那個目錄可能還不存在
        const log = openSync(join(dir, 'scheduler.log'), 'a');
        // 🔴 2026-08-10 測試抓到（第一版直接傳 process.env，結果【永遠起不來】）：
        //   http.mjs:66 會拒絕在 GUANLING_AGENT 有值時啟動 —— 那個守衛是【對的】：
        //   它的身分要 per-request 從 token 推導，一個 process 級的身分會在推導失敗時
        //   靜默變成 fallback。而 plugin 這側【一定】有 GUANLING_AGENT（那是它知道要讀誰的清單的方式）
        //   ⇒ 直接繼承 env = 子行程必然自殺，而 spawn 本身成功、log 也寫了，
        //      **從 plugin 這側看起來完全正常**。這是讀碼看不出來、只有真跑才會紅的一格。
        const env = { ...process.env };
        delete env.GUANLING_AGENT;   // 身分：伺服器版必須 per-request 從 token 推
        delete env.GUANLING_FILE;    // 單一 agent 的 store 路徑：伺服器服務多人，不能被釘在一個人身上
        const child = spawn(process.execPath, [join(HERE, 'http.mjs')], {
          detached: true,            // 🔑 脫離這個 session：plugin 會死，排程不能跟著死
          stdio: ['ignore', log, log],
          env,
        });
        child.unref();               // 不讓它把我們的 event loop 綁住
      } catch { /* 起不來就算了 —— 工具照常可用，只是沒有排程 */ }
    });
  } catch { /* 連探測都做不到（環境缺 net?）⇒ 靜默放棄，不影響工具 */ }
}

if (IS_MAIN) {
  ensureScheduler();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { send(dispatch(JSON.parse(line))); } catch { /* drop malformed lines; never die on input */ } }
    }
  });
}
