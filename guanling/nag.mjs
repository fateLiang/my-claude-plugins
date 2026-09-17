#!/usr/bin/env node
/**
 * nag.mjs <store.json> — decide whether an agent's task list needs attention.
 *
 * Prints nothing and exits 0 when there is nothing worth acting on. That silence
 * is the point: a daily "all clear" trains the reader to stop looking, which
 * disables the alarm while leaving it switched on.
 *
 * Exit codes are the contract (the caller branches on these, not on the text):
 *   0 = nothing to do          1 = something needs attention (details on stdout)
 *   2 = could not read the store (a real error — must not look like "nothing to do")
 *
 * ⚠️ 2 exists because "no store" and "clean store" are indistinguishable if both
 * exit 0, and the first one means the agent is not wired up at all.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolveStore } from './store-path.mjs';

// Accepts either a path or a bare agent name. A name is preferred: it goes through the
// SAME resolver the server uses, so the sweep cannot end up looking somewhere the server
// never writes — a divergence that would read as "clean" forever.
const ARG = process.argv[2];
const FILE = (ARG && (ARG.includes('/') || ARG.endsWith('.json'))) ? ARG : resolveStore(ARG);
if (!FILE) { console.error('usage: nag.mjs <store.json>'); process.exit(2); }
if (!existsSync(FILE)) { console.error(`nag: store not found: ${FILE}`); process.exit(2); }

let db;
try { db = JSON.parse(readFileSync(FILE, 'utf8')); }
catch (e) { console.error(`nag: unreadable store ${FILE}: ${e.message}`); process.exit(2); }

// ⭐ 2026-08-09: everything below assumes db.tasks is an array. It wasn't checked, so a
// file that parsed as JSON but was not a guanling store exited 0 — "nothing to act on".
// Measured: {}, [], and {version,agent} with no tasks key ALL reported clean.
// That is this tool's own worst failure mode wearing its best outcome: a broken list is
// indistinguishable from an empty one, and the sweep goes quiet forever.
// A store we cannot understand is exit 2 (unreadable), never exit 0.
if (!db || typeof db !== 'object' || Array.isArray(db) || !Array.isArray(db.tasks)) {
  console.error(`nag: ${FILE} parsed as JSON but is not a guanling store ` +
    `(no tasks array). Refusing to report it as clean.`);
  process.exit(2);
}


const days = (iso) => (Date.now() - Date.parse(iso)) / 86400000;
const OPEN = ['triage', 'todo', 'doing'];
const open = (db.tasks || []).filter((t) => OPEN.includes(t.status));

const doing  = open.filter((t) => t.status === 'doing');
const triage = open.filter((t) => t.status === 'triage');
// ⭐ hades 2026-08-09, the structural one: `updated` was this tool's ONLY clock, and
// several calls that change nothing reset it (a no-op task_update, snooze, a
// self-asserted ack, re-delegation). Four independent attack lines converged here,
// which is why the fix belongs in the clock rather than in those four callers.
// One field was answering two questions; an alarm only wants the second:
//   updated    — did anyone touch this
//   progressed — did the state actually advance (status / owner / next_step)
// Falls back to created so tasks written before the field ages from something real.
const moved  = (t) => t.progressed || t.created;
const stale  = open.filter((t) => days(moved(t)) >= 7);
const rolled = open.filter((t) => (t.rolled || 0) >= 3);
// Same rule as the write gate — if these two disagree, the gate lets in exactly what
// the scan will complain about tomorrow. Character count is not the test: CJK carries
// far more per character ("改兩份模板" is 5 chars and fully actionable).
const FILLER = new Set([
  'x','xx','tbd','todo','tba','?','??','-','--','n/a','na','none',
  'later','soon','fix','fix it','do it','check','look','see','ship',
  '看看','再看','再說','處理','處理一下','待定','待辦','之後','有空再說','再處理',
]);
const isFiller = (v) => {
  // Collapse internal whitespace too — ebola 2026-08-09: "fix  it" (two spaces)
  // slipped past the "fix it" entry. A blocklist that can be evaded by a space is
  // weaker than it reads.
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[。．.!！]+$/, '');
  return !t || t.length < 2 || FILLER.has(t);
};
const woolly = open.filter((t) => isFiller(t.next_step));
const line = (t) => `  #${t.id} [${t.status}] ${t.title}\n      next_step: ${t.next_step || '(none)'}  · ${Math.floor(days(moved(t)))}d without progress · rolled ${t.rolled || 0}`;

// The sweep that task_delegate's success message promises. Before this existed, that
// promise was printed at the exact moment the user was most willing to believe it —
// hades 2026-08-09 (F2). It is also the compensating control for the one thing a sender
// can never establish: a transport that exits 0 having delivered nothing (F3). Nobody
// can prove delivery from this side; what we CAN do is refuse to let silence look fine.
//
// ⚠️ Ages from delegated.sent, never from t.updated — a one-sided ack used to refresh
// updated and therefore pushed back the only alarm that would have exposed it (F4).
const deleg = open.filter((t) => t.delegated);
// A self-asserted ack does not count as an answer. Treating it as one is how the
// sender silences their own alarm — so the sweep keeps watching until there is
// evidence a third party could read.
const unacked = deleg.filter((t) =>
  days(t.delegated.sent) >= 1 &&
  (!t.delegated.acked || t.delegated.ack_source === 'self-asserted'));
const dline = (t) => `  #${t.id} → ${t.delegated.to} · sent ${Math.floor(days(t.delegated.sent))}d ago · ` +
  `${t.delegated.acked ? 'marked ' + t.delegated.response + ' BY YOU, no evidence' : 'no reply'}\n      asked: ${t.delegated.ask}`;

const blocks = [];

// ⭐ ebola's rule, and it is the general one: ANYTHING A WHITELIST FILTERS OUT MUST BE
// COUNTED. OPEN = ['triage','todo','doing'] is a whitelist, so a status of "ToDo" is not
// bad data — it is *absent*. One typo makes a ticket permanently invisible while the
// other 30 keep working, so the report looks entirely normal and is merely missing part
// of its population. Same for an unparseable date: Date.parse -> NaN, NaN >= 7 is false,
// and that ticket can never go stale.
// A filter that silently shrinks the population is the same defect as a guard that
// silently does not run.
// These exit 1 (the agent can fix them), not 2 (that means "not wired up at all").
const KNOWN = new Set(['triage', 'todo', 'doing', 'done', 'dropped']);
const anomalies = [];
for (const t of db.tasks) {
  const id = t?.id ?? '?';
  if (!t || typeof t !== 'object') { anomalies.push(`#${id} is not an object`); continue; }
  if (!t.status) anomalies.push(`#${id} has no status — invisible to every check`);
  else if (!KNOWN.has(t.status))
    anomalies.push(`#${id} status "${t.status}" is not one of ${[...KNOWN].join('/')} — invisible to every check`);
  if (!t.title) anomalies.push(`#${id} has no title`);
  // created/updated are required — null is just as un-ageable as "not-a-date", and my
  // first version skipped null because it read as "field absent, nothing to check".
  for (const f of ['created', 'updated'])
    if (t[f] == null || Number.isNaN(Date.parse(t[f])))
      anomalies.push(`#${id} ${f}=${JSON.stringify(t[f])} does not parse — this task can never age`);
  for (const f of ['blocked_since', 'snooze_until'])   // optional: null is legitimate
    if (t[f] != null && Number.isNaN(Date.parse(t[f])))
      anomalies.push(`#${id} ${f}="${t[f]}" does not parse`);
}
if (anomalies.length)
  blocks.push(`UNREADABLE RECORDS — these are excluded from every other check, so the ` +
    `rest of this report is computed on a smaller list than you think:\n` +
    anomalies.map((a) => `  ${a}`).join('\n'));
// ⭐ hades 2026-08-09, wording not behaviour: declined tickets were appearing under
// "you believe these are moving", which is false for them — they are not unanswered,
// they came back. Keeping them in the sweep is right (a decline with no evidence is
// still only your assertion), but the two states need different ACTIONS: one is "go
// chase a person", the other is "decide yourself whether to do it". Sharing a heading
// tells the reader to do the wrong one.
const declined = unacked.filter((t) => t.delegated.response === 'declined');
const silent   = unacked.filter((t) => t.delegated.response !== 'declined');
if (silent.length)
  blocks.push(`DELEGATED, NEVER ACKNOWLEDGED — you believe these are moving:\n` +
    silent.map(dline).join('\n') +
    `\n  Nothing on this side can prove the message arrived. Chase them, or take it back.`);
if (declined.length)
  blocks.push(`CAME BACK DECLINED — these are not waiting on anyone, they are waiting ` +
    `on YOU:\n` +
    declined.map(dline).join('\n') +
    `\n  Nobody else is going to do these. Do it yourself, or drop it with a reason.`);
// Nothing started at all. Every other check here looks for rot — something that was
// once moving and stopped. This one looks for the opposite failure: a list that has
// never moved. It is easy to miss because every individual task looks fine; only the
// aggregate is wrong. Found on the first real run: 29 open, 0 doing, while the agent
// was actively working — so the list described nobody's actual day.
// Not gated on staleness: on day one, "you imported a backlog and picked nothing" is
// exactly when saying so is most useful.
const actionable = open.filter((t) => t.status === 'todo' && !t.blocked_on);
if (actionable.length >= 3 && doing.length === 0)
  blocks.push(`NOTHING STARTED — ${actionable.length} unblocked tasks, none in doing.\n` +
    `  A list where nothing is in progress records intentions, not work.\n` +
    `  Pick what you are actually doing next and move it to doing (limit ${db.wip_limit}):\n` +
    actionable.slice(0, 8).map(line).join('\n') +
    (actionable.length > 8 ? `\n  …and ${actionable.length - 8} more` : ''));

// ⭐ hades C1/C2 2026-08-09. NOTHING STARTED above triggers on `doing === 0` — and that
// trigger is itself a SINGLE-ROW fact, so a gate written to catch "every row looks fine
// while the whole thing is stuck" carries the very blind spot it exists to close:
//   C1  one task marked doing bought silence for 30 stalled ones
//   C2  three tasks in doing, untouched six days, WIP exactly at the limit → silent
// Both are answered by asking the list-level question directly, with no proxy for it.
// This needs `progressed` to exist: with the old clock, any write at all reset it, so
// "has anything actually moved" was not a question the data could answer.
const STALL_DAYS = 5;
// 🔴 C1 residual, closed 2026-08-09. `every()` was truthful to the heading but it handed a
// veto to any single row: touch one task out of 31 and the other 30 rot in silence — the
// exact "one row bought silence for the rest" shape hades reported one layer up. Firing on
// "all but at most one" kills that veto while keeping the alarm RARE, which matters just as
// much: an alarm that fires every day gets read as wallpaper and is off in practice.
// ⚠️ Honest about what is still open: TWO fresh rows still veto. That is not a closed hole,
// it is a cheaper one, and the message now prints the ratio so the number cannot hide.
const stalled = open.filter((t) => days(moved(t)) >= STALL_DAYS);
// 🔑 2026-08-09 第二輪：門檻改成【從設定推導】，不再是「除了至多一列」那個魔術數。
//   上一版寫 stalled >= open-1，我自己標了殘留：【兩列】新鮮就能否決。
//   而「1」跟先前那個寫死的「2」是同一種東西 —— 我只是把魔術數換了位置。
// ✅ 改問一個【設定回答得了】的問題：**在動的東西，有沒有少到不構成進度？**
//   判準 = 正在動的 < wip_limit。理由：wip_limit 是你自己宣告「我一次做得動幾件」，
//   若連那個數都達不到，這份清單就不是在前進 —— 而這個數會跟著設定走，不用我挑。
//   （同一晚備份健檢那顆的同一招：期望值從 crontab+FS 推導，不寫死。）
// ⚠️ 仍然稀有：wip_limit 預設 6（2026-08-10 從 3 調高）⇒ 要「動的 < 6」才叫。天天響的告警＝壁紙。
const wipLimit = db.wip_limit ?? 6;
const moving = open.length - stalled.length;
if (open.length >= 3 && moving < wipLimit && stalled.length >= 3)
  blocks.push(`NOTHING IS MOVING — ${stalled.length} of ${open.length} open tasks have not ` +
    `changed status, owner or next_step in ${STALL_DAYS}+ days.\n` +
    `  Having something marked "doing" is not the same as doing it.\n` +
    `  Move one, or admit this is a wish-list and close some:\n` +
    stalled.slice(0, 6).map(line).join('\n') +
    (stalled.length > 6 ? `\n  …and ${stalled.length - 6} more` : ''));
// ⭐ ebola: "blocked" was the only state in this tool with no age. A state with no age
// becomes the bin everything gets swept into — and here it was worse than a bin, because
// entering it silenced two alarms at once. Ages from blocked_since, which only the
// null→value transition sets, so re-writing blocked_on cannot buy more silence.
const stuck = open.filter((t) => t.blocked_on && t.blocked_since && days(t.blocked_since) >= 14);
if (stuck.length)
  blocks.push(`BLOCKED FOR 14+ DAYS — being blocked is not a resting state:\n` +
    stuck.map((t) => `  #${t.id} blocked on ${t.blocked_on} for ${Math.floor(days(t.blocked_since))}d\n      ${t.title}`).join('\n') +
    `\n  Chase whoever it is, or accept it is not happening and close it.`);
if (doing.length > (db.wip_limit ?? 6))
  blocks.push(`OVER WIP — ${doing.length} in doing, limit ${db.wip_limit}:\n` + doing.map(line).join('\n'));
if (rolled.length)
  blocks.push(`ROLLED 3+ TIMES — these will not finish on their own:\n` + rolled.map(line).join('\n'));
if (woolly.length)
  blocks.push(`NO USABLE NEXT STEP — unresumable after a context reset:\n` + woolly.map(line).join('\n'));
if (stale.length)
  blocks.push(`UNTOUCHED 7+ DAYS:\n` + stale.slice(0, 10).map(line).join('\n')
    + (stale.length > 10 ? `\n  …and ${stale.length - 10} more` : ''));
if (triage.length >= 5)
  blocks.push(`TRIAGE BACKLOG — ${triage.length} unsorted:\n` + triage.slice(0, 10).map(line).join('\n'));

process.on('uncaughtException', (e) => {   // a crash is unreadable (2), not findings (1)
  console.error(`nag: failed while scanning ${FILE}: ${e.message}`); process.exit(2);
});

if (!blocks.length) process.exit(0);           // silent when healthy

console.log(`agent=${db.agent}  open=${open.length}  wip=${doing.length}/${db.wip_limit}  cycle=${db.cycle?.n}\n`);
console.log(blocks.join('\n\n'));
process.exit(1);
