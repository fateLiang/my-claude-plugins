// guanling acceptance test. Every arm states what it is asking.
// The refusal arms are the point — the refusals ARE the product, so they get
// the most coverage, including a negative control that a rejected call leaves
// nothing behind on disk.
import { spawn } from 'node:child_process';
import { dispatch as _dispatch } from './server.mjs';
import { rmSync, existsSync, readFileSync } from 'node:fs';
const F = '/tmp/guanling-selftest.json';
if (existsSync(F)) rmSync(F);
import { fileURLToPath } from 'node:url';
import { dirname as _dn, join as _join } from 'node:path';
// Resolve relative to THIS file, not the caller's cwd — running the suite from a
// different directory used to fail in a way that produced no output at all, which
// reads exactly like a pass when piped through .
const HERE = _dn(fileURLToPath(import.meta.url));
const SERVER = _join(HERE, 'server.mjs');
const p = spawn('node', [SERVER], { cwd: HERE, env: { ...process.env, GUANLING_AGENT:'test', GUANLING_FILE:F, GUANLING_WIP:'2' }, stdio:['pipe','pipe','inherit'] });
let id=0, pend=new Map(), buf='';
p.stdout.on('data', c => { buf+=c; let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i); buf=buf.slice(i+1);
  if(!l.trim())continue; const m=JSON.parse(l); const r=pend.get(m.id); if(r){pend.delete(m.id); r(m);} }});
const call=(method,params)=>new Promise(r=>{const i=++id;pend.set(i,r);p.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method,params})+'\n');});
const tool=async(n,a={})=>{const m=await call('tools/call',{name:n,arguments:a});return JSON.parse(m.result.content[0].text);};
let pass=0,fail=0;
const dispatchOf=(m)=>_dispatch({jsonrpc:'2.0',id:1,method:m});
const chk=(label,cond,got)=>{ if(cond){pass++;console.log(`  PASS  ${label}`);} else {fail++;console.log(`  FAIL  ${label}\n        got: ${JSON.stringify(got)}`);} };

await call('initialize',{});
const tl = await call('tools/list',{});
// 🩸 這行原本寫 8，而工具早就變成 9（task_drain 加進來時沒人改它）⇒ 它【每次都紅】。
//    恆紅的檢查會被習慣，等於關掉：今天我跑它，第一反應是「喔那個一直都紅」——
//    那正是它已經不再保護任何東西的證據。→ memory: a_permanently_failing_item_is_an_unprotected_item
chk('tools/list returns 9 tools', tl.result.tools.length===9, tl.result.tools.map(t=>t.name));

console.log('\n  -- refusal arms (this is the product) --');
chk('no owner is rejected',      (await tool('task_add',{title:'x',next_step:'y'})).error?.includes('owner'));
chk('no next_step is rejected',  (await tool('task_add',{title:'x',owner:'me'})).error?.includes('next_step'));
const a=await tool('task_add',{title:'A',owner:'me',next_step:'do A'});
const b=await tool('task_add',{title:'B',owner:'me',next_step:'do B'});
const c=await tool('task_add',{title:'C',owner:'me',next_step:'do C'});
chk('three valid tasks all open', a.ok&&b.ok&&c.ok, [a,b,c]);
await tool('task_update',{id:a.id,status:'doing'});
await tool('task_update',{id:b.id,status:'doing'});
const over=await tool('task_update',{id:c.id,status:'doing'});
chk('WIP limit 2: the third is rejected', over.error?.includes('limit of 2'), over);
chk('  and the refusal names what occupies the limit', over.error?.includes('#1')&&over.error?.includes('#2'), over.error);
chk('closing without a reason is rejected', (await tool('task_update',{id:a.id,status:'done'})).error?.includes('reason'));
chk('an invented status is rejected', (await tool('task_update',{id:a.id,status:'blocked'})).error?.includes('status must be one of'));

console.log('\n  -- next_step must be an action, not filler --');
chk('filler "x" is rejected',   (await tool('task_add',{title:'t',owner:'o',next_step:'x'})).error?.includes('filler'));
chk('filler "TBD" is rejected', (await tool('task_add',{title:'t',owner:'o',next_step:'TBD'})).error?.includes('filler'));
chk('CJK filler is rejected',   (await tool('task_add',{title:'t',owner:'o',next_step:'看看'})).error?.includes('filler'));
// The discriminating arm. A naive "too short = reject" rule would fail this, and that
// rule is what a character count gives you: CJK says far more per character, so five
// characters can be a complete instruction. If this ever goes red the rule has
// regressed into counting length.
const cjk = await tool('task_add',{title:'t',owner:'o',next_step:'改兩份模板'});
chk('  but a SHORT CJK action is accepted (not a length rule)', cjk.ok === true, cjk);
await tool('task_update',{id:cjk.id,status:'dropped',reason:'test fixture'});

console.log('\n  -- the same gates must hold on UPDATE, not only on create --');
// Found by ebola 2026-08-09 by end-to-end probing, not by reading: task_update wrote
// owner/next_step with no validation at all, so a task could be opened clean and then
// emptied. An invariant checked only at creation is not an invariant — every later
// write is a legal call that returns ok:true.
const upd = await tool('task_add',{title:'update-gate fixture',owner:'me',next_step:'a real concrete action here'});
chk('update to filler next_step is rejected',
    (await tool('task_update',{id:upd.id,next_step:'看看'})).error?.includes('filler'));
chk('update to empty next_step is rejected',
    (await tool('task_update',{id:upd.id,next_step:''})).error?.includes('cannot be emptied'));
chk('update to empty owner is rejected',
    (await tool('task_update',{id:upd.id,owner:''})).error?.includes('cannot be emptied'));
chk('filler evading via double space is rejected',
    (await tool('task_update',{id:upd.id,next_step:'fix  it'})).error?.includes('filler'));
// Positive control: the gate must not freeze the fields — legitimate edits still land.
const good = await tool('task_update',{id:upd.id,next_step:'grep every caller before touching it'});
chk('  positive control: a legitimate update still applies', good.ok === true, good);
const after2 = (await tool('task_list',{})).tasks.find(t=>t.id===upd.id);
chk('  and the task never became a shell (owner+next_step both intact)',
    !!after2.owner && !!after2.next_step, after2);
await tool('task_update',{id:upd.id,status:'dropped',reason:'test fixture'});

console.log('\n  -- "waiting" is a legitimate state, but not an anonymous one --');
// hades 2026-08-09: the filler list is bound to literal strings, so it blocks the
// phrasings you thought of and nothing else. Every waiting-shaped step sailed through
// — and those rot fastest: nothing will ever mark them done. He measured the decay at
// five minutes. The fix is not more words; it is binding to the property: if the next
// step is "wait", name who, which makes the item visible to the sweep.
chk('waiting with no blocked_on is rejected',
    (await tool('task_add',{title:'t',owner:'o',next_step:'等 Robert 決定要不要建'})).error?.includes('waiting'));
chk('English waiting is rejected too',
    (await tool('task_add',{title:'t',owner:'o',next_step:'waiting for review'})).error?.includes('waiting'));
chk('no-actor forms are rejected (追蹤中/持續觀察)',
    (await tool('task_add',{title:'t',owner:'o',next_step:'追蹤中'})).error?.includes('waiting'));
// ⚠️ SUPERSEDED 2026-08-09 by the pre-emptive constraint. This arm used to assert that
// naming someone in blocked_on was enough. It is not: writing their name still tells them
// nothing. Naming a person now REQUIRES having actually sent them something, so the same
// input is refused and the caller is pointed at task_delegate.
// Keeping the arm (inverted) rather than deleting it, so the tightening is visible in the
// suite instead of silently disappearing.
const named = await tool('task_add',{title:'t',owner:'o',next_step:'等 Robert 決定要不要建',blocked_on:'Robert'});
chk('  naming a person in blocked_on is NOT enough — must go through delegate',
    named.error?.includes('names a person'), named);
// And the condition form — a blocker with nobody to notify — still passes.
const cond = await tool('task_add',{title:'t',owner:'o',next_step:'等 dist 發版再處理',blocked_on:'下次 dist 發版'});
chk('  a non-person blocker (a release, a window) is still allowed', cond.ok === true, cond);
// 🔑 The arm that caught my own first attempt. I bound the rule to a leading 等 and
// this went red: 等價 is a word, not a verb governing someone. If it reddens again the
// rule has slid back to matching characters instead of meaning.
const cmpd = await tool('task_add',{title:'t',owner:'o',next_step:'等價交換的設計要重寫'});
chk('  but 等價/等級 (compound words, not waiting) are NOT blocked', cmpd.ok === true, cmpd);
for (const id of [cond.id, cmpd.id]) await tool('task_update',{id,status:'dropped',reason:'test fixture'});

console.log('\n  -- normal flow --');
chk('done + reason succeeds', (await tool('task_update',{id:a.id,status:'done',reason:'shipped'})).ok);
const nowOk=await tool('task_update',{id:c.id,status:'doing'});
chk('after closing one, the third fits (limit is live, not a one-shot)', nowOk.ok, nowOk);
const ext=await tool('task_add',{title:'from outside',owner:'me',next_step:'triage it',source:'slack'});
chk('a task with source lands in triage, not todo', ext.status==='triage', ext);
chk('triage accept moves it to todo', (await tool('task_triage',{id:ext.id,action:'accept'})).task.status==='todo');

console.log('\n  -- delegation: a handoff nobody received is not a handoff --');
{
  const { spawnSync } = await import('node:child_process');
  const DF='/tmp/guanling-deleg.json', DQ='/tmp/guanling-deleg-q.jsonl';
  for (const f of [DF,DQ]) if (existsSync(f)) rmSync(f);
  // 🔴 HOME 必須隔離。2.5.0 起「沒設 GUANLING_SEND_CMD」會退回找 ~/.guanling/send，
  //    而這台機器上那個掛勾是【存在】的 ⇒ 不隔離的話，本該驗「沒有傳輸時會拒絕」的那一格
  //    會改走真實傳輸。測試必須不受【跑它的那台機器裝了什麼】影響，否則它量的是這台機器
  //    不是這份碼。（實測：不隔離時該格由 PASS 轉 FAIL，因為拒絕理由從 SEND_CMD 變成投遞失敗。）
  const HOMELESS='/tmp/guanling-selftest-home';
  const call=(args,cmd='/home/dev/qimenzi/scripts/guanling-send.sh')=>{
    const r=spawnSync('node',[SERVER],{cwd:HERE,encoding:'utf8',
      env:{...process.env,HOME:HOMELESS,GUANLING_AGENT:'dtest',GUANLING_FILE:DF,GUANLING_OUTBOX:DQ,GUANLING_SEND_CMD:cmd},
      input:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:args.n,arguments:args.a}})+'\n'});
    const l=r.stdout.trim().split('\n').filter(Boolean).pop();
    return JSON.parse(JSON.parse(l).result.content[0].text);
  };
  chk('delegate with no transport configured is rejected',
      call({n:'task_delegate',a:{to:'x',title:'t',next_step:'a real action to take'}},'').error?.includes('SEND_CMD'));
  chk('delegate with a waiting next_step is rejected',
      call({n:'task_delegate',a:{to:'x',title:'t',next_step:'等他回覆'}}).error?.includes('waiting'));
  const ok1 = call({n:'task_delegate',a:{to:'hades',title:'review',next_step:'read the state machine and find the lying paths'}});
  chk('  a valid delegation is accepted and records the recipient', ok1.ok && ok1.delegated_to==='hades', ok1);
  // 🔑 The load-bearing arm. If the transport fails and a ticket still appears, the tool
  // has rebuilt the exact disease it exists to prevent: a handoff that never left the
  // machine, sitting in the list looking tracked.
  const before = JSON.parse(readFileSync(DF,'utf8')).tasks.length;
  const failed = call({n:'task_delegate',a:{to:'hades',title:'t',next_step:'another real action here'}},'/bin/false');
  const after  = JSON.parse(readFileSync(DF,'utf8')).tasks.length;
  chk('transport failure is rejected AND writes no ticket', !!failed.error && after===before, {failed,before,after});
  // ⚠️ First version of these two arms was wrong, not the code: I acked ok1 and then
  // tested decline on the same (now-acked) task, so it failed with "already
  // acknowledged" instead of the reason check. Each arm needs its own fresh subject.
  const plain = call({n:'task_add',a:{title:'not delegated',owner:'me',next_step:'a concrete action here'}});
  chk('ack on a task that was never delegated is rejected',
      call({n:'task_ack',a:{id:plain.id,response:'accepted'}}).error?.includes('never delegated'));
  const fresh = call({n:'task_delegate',a:{to:'hades',title:'d2',next_step:'another concrete action'}});
  // 🔴 ebola 2026-08-09: the spec document's own example satisfied every rule a drain
  // would apply, so merely SENDING that document would have manufactured an ack for a
  // live delegation. A specimen and an instance are byte-identical; the discriminator
  // made acks findable, never proved one was made. The nonce is the part a specimen
  // cannot carry. If these arms go green with a stale nonce, specimens are live again.
  const nd = call({n:'task_delegate',a:{to:'hades',title:'nonce',next_step:'read the state machine'}});
  const store = JSON.parse(readFileSync(DF,'utf8'));
  const realNonce = store.tasks.find(t=>t.id===nd.id).delegated.nonce;
  chk('  a delegation mints a nonce', !!realNonce && realNonce.length >= 8, realNonce);
  chk('  evidence with a SPECIMEN nonce is rejected',
      call({n:'task_ack',a:{id:nd.id,response:'accepted',evidence:'msg 1',nonce:'SPECIMEN-NOT-A-REAL-NONCE'}})
        .error?.includes('nonce does not match'));
  const good = call({n:'task_ack',a:{id:nd.id,response:'accepted',evidence:'mesh 15471',nonce:realNonce}});
  chk('  evidence WITH the real nonce is accepted as evidenced',
      good.ok && good.task.delegated.ack_source === 'evidenced', good);
  // hades N1: the daily view must distinguish an evidenced ack from one I typed. The F1
  // fix (surfacing delegation in task_list) had become F4's new hiding place — a field
  // added to end concealment must itself be checked for what it conceals.
  const n1 = call({n:'task_delegate',a:{to:'x',title:'n1',next_step:'a concrete action'}});
  const n1nonce = JSON.parse(readFileSync(DF,'utf8')).tasks.find(t=>t.id===n1.id).delegated.nonce;
  call({n:'task_ack',a:{id:n1.id,response:'accepted',evidence:'m 1',nonce:n1nonce}});
  const n1row = call({n:'task_list',a:{}}).tasks.find(t=>t.id===n1.id);
  chk('  task_list distinguishes evidenced from self-asserted',
      /evidenced/.test(n1row.delegation.state), n1row.delegation);
  // hades N2: editing next_step on a delegated-unacked ticket was accepted then silently
  // reverted — changing what I see and nothing they see.
  const n2 = call({n:'task_delegate',a:{to:'x',title:'n2',next_step:'the original ask here'}});
  chk('  editing next_step on a delegated, unacked task is refused',
      call({n:'task_update',a:{id:n2.id,next_step:'quietly something else'}}).error?.includes('not yet acknowledged'));
  chk('  a decline without their reason is rejected',
      call({n:'task_ack',a:{id:fresh.id,response:'declined'}}).error?.includes('reason'));
  const dok = call({n:'task_ack',a:{id:fresh.id,response:'declined',reason:'not my domain, ask ebola'}});
  chk('  a declined task comes BACK to me, not into limbo',
      dok.ok && dok.task.blocked_on === null && /declined/.test(dok.task.next_step), dok);
}

console.log('\n  -- the sweep the success message promises must actually exist --');
{
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const iso = (d) => new Date(Date.now() - d*86400000).toISOString();
  const mk = (id, acked, sentDaysAgo) => ({
    id, title:`d${id}`, owner:'me', next_step:'awaiting x: do the thing', status:'todo',
    rolled:0, created:iso(sentDaysAgo), updated:new Date().toISOString(), blocked_on:'x',
    source:null, closed_reason:null, cycle:1,
    delegated:{ to:'x', sent:iso(sentDaysAgo), acked, ask:'do the thing' } });
  const run = (tasks) => {
    const f = '/tmp/guanling-sweep-test.json';
    writeFileSync(f, JSON.stringify({version:1,agent:'t',wip_limit:3,
      cycle:{n:1,start:iso(0),days:14},seq:9,tasks}));
    return spawnSync('node',[_join(HERE,'nag.mjs'),f],{encoding:'utf8'}).status;
  };
  chk('unacknowledged for 2 days is surfaced', run([mk(1,null,2)]) === 1);
  chk('  acknowledged is NOT surfaced', run([mk(2,new Date().toISOString(),2)]) === 0);
  chk('  just-sent is NOT surfaced (no same-day nagging)', run([mk(3,null,0)]) === 0);
  // 🔑 F4: a one-sided ack used to refresh t.updated, which was the only clock. If
  // touching updated can silence this, the fake ack has again delayed its own alarm.
  const faked = mk(4,null,3); faked.updated = new Date().toISOString();
  chk('  refreshing `updated` does NOT silence it (ages from sent)', run([faked]) === 1);
  // 🔑 Robert 2026-08-09: "有排程也修不掉?" — he was right that my "unfixable" was too
  // strong. A sender still cannot prove delivery, but it CAN refuse to accept its own
  // word as a reply. A self-asserted ack no longer buys silence; only evidence a third
  // party could read does. If this arm goes green with no evidence, marking it yourself
  // has again become indistinguishable from being answered.
  const selfAck = mk(5,new Date().toISOString(),3); selfAck.delegated.ack_source='self-asserted';
  chk('  a SELF-asserted ack does not silence the sweep', run([selfAck]) === 1);
  const evid = mk(6,new Date().toISOString(),3);
  evid.delegated.ack_source='evidenced'; evid.delegated.evidence='mesh msg 15461';
  chk('  an EVIDENCED ack does silence it', run([evid]) === 0);
}

console.log('\n  -- cycle --');
const cs=await tool('cycle_status',{});
chk('cycle_status reports WIP', cs.wip==='2/2', cs);
const roll=await tool('cycle_roll',{});
chk('roll advances to the next cycle', roll.new_cycle===2, roll);
const after=await tool('task_list',{});
chk('carried tasks each have rolled incremented', after.tasks.every(t=>t.rolled===1), after.tasks);

console.log('\n  -- negative control: a rejected call must leave NO trace --');
const before=(await tool('task_list',{status:'open'})).count;
await tool('task_add',{title:'should be rejected',owner:'me'});
chk('rejected task_add wrote nothing to disk', (await tool('task_list',{status:'open'})).count===before);

console.log('\n  -- isolation: an unconfigured instance must NOT quietly share a store --');
{
  const { spawnSync } = await import('node:child_process');
  // Both env vars absent: must refuse to start rather than fall back to a shared default.
  const bare = spawnSync('node', [SERVER],
    { cwd: HERE, env: Object.fromEntries(Object.entries(process.env)
        .filter(([k]) => !k.startsWith('GUANLING_'))), encoding: 'utf8', input: '' });
  chk('no GUANLING_AGENT and no GUANLING_FILE => refuses to start',
      bare.status === 2 && /refusing to start/.test(bare.stderr), { status: bare.status, stderr: bare.stderr.slice(0,120) });
  // Positive control: the same launch WITH config must still start, or the arm above
  // would pass for the wrong reason (e.g. the server is simply broken).
  // It must also WRITE — `initialize` alone never touches the store, so a read-only
  // control would leave no file and the ownership arm below would test nothing.
  const ok = spawnSync('node', [SERVER],
    { cwd: HERE, env: { ...process.env, GUANLING_AGENT: 'ctl', GUANLING_FILE: '/tmp/guanling-ctl.json' },
      encoding: 'utf8',
      input: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n' +
             '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"task_add",' +
             '"arguments":{"title":"ctl","owner":"ctl","next_step":"ctl"}}}\n' });
  chk('  positive control: WITH config it starts and writes its store',
      /guanling-ctl/.test(ok.stdout) && existsSync('/tmp/guanling-ctl.json'), ok.stdout.slice(0,120));
  // Two names, one file: must be detected, not silently merged.
  const clash = spawnSync('node', [SERVER],
    { cwd: HERE, env: { ...process.env, GUANLING_AGENT: 'other', GUANLING_FILE: '/tmp/guanling-ctl.json' },
      encoding: 'utf8', input: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_list","arguments":{}}}\n' });
  chk('two names pointed at one file => ownership mismatch is reported',
      /ownership mismatch/.test(clash.stdout), clash.stdout.slice(0,160));
}


// ── ebola 2026-08-09: blocked_on was the cheapest way to whitewash a stalled list ──
// One unvalidated field that removed the task from NOTHING STARTED's population AND
// refreshed `updated`, killing UNTOUCHED 7+ DAYS in the same write. Eight calls and a
// dead list reports healthy. blocked_since only moves on the null → value transition,
// so rewriting the blocker cannot buy more silence.
{
  const b = await tool('task_add', { title: 'stalled thing', owner: 'me', next_step: '一個具體的動作' });
  const bid = b.id ?? b.task?.id;
  await tool('task_update', { id: bid, blocked_on: 'waiting on review' });
  const first = JSON.parse(readFileSync(F, 'utf8')).tasks.find(t => t.id === bid).blocked_since;
  chk('blocked_since is set when a task first becomes blocked', !!first, first);
  await new Promise((r) => setTimeout(r, 1100));
  await tool('task_update', { id: bid, blocked_on: 'still waiting on review' });
  const second = JSON.parse(readFileSync(F, 'utf8')).tasks.find(t => t.id === bid).blocked_since;
  chk('rewriting blocked_on does NOT reset blocked_since (no free silence)', second === first, { first, second });
  await tool('task_update', { id: bid, blocked_on: '' });
  const cleared = JSON.parse(readFileSync(F, 'utf8')).tasks.find(t => t.id === bid).blocked_since;
  chk('clearing blocked_on clears blocked_since', cleared === null, cleared);
  await tool('task_update', { id: bid, status: 'dropped', reason: 'selftest fixture' });
}

// ── ⭐ The precondition that makes one-server-many-clients safe ──────────────
// http.mjs sets identity per request and then calls dispatch(). That is only sound
// while every handler is SYNCHRONOUS: with an await inside, request B could set the
// identity while request A is suspended mid-handler, and A's write would land in B's
// file. Silent, and nearly impossible to reconstruct afterwards.
// So the precondition gets a test rather than a comment. A comment would not have
// stopped anyone — this is the same lesson as every other gate in this file.
{
  const src = readFileSync(_join(HERE, 'server.mjs'), 'utf8');
  const toolsFrom = src.indexOf('const TOOLS');
  const toolsTo   = src.indexOf('export function dispatch');
  const body = src.slice(toolsFrom, toolsTo);
  const offenders = body.split('\n')
    .map((l, i) => [i, l])
    .filter(([, l]) => /\bawait\b|\basync\b/.test(l) && !l.trim().startsWith('//'));
  chk('every tool handler is synchronous (async would leak identity between HTTP requests)',
      offenders.length === 0, offenders.slice(0, 3));

  // And prove it at runtime too, not only in the source: a Promise here means the
  // HTTP path can interleave.
  const r = dispatchOf('tools/list');
  chk('dispatch() returns a value, not a Promise', !(r instanceof Promise), typeof r);
}

// ── 版號三處一致 ────────────────────────────────────────────────────────────
// 🩸 2.4.0 出貨時我只 bump 了 plugin.json 與 package.json，漏掉 server.mjs 的
//    VERSION ⇒ 伺服器對每個 client 自報 2.3.1，而安裝紀錄說 2.4.0。發現它純屬偶然
//    （我在看別的東西時瞄到）。代價不是難看：出事時「你跑哪一版」是唯一的線索，
//    而那條線索當時是錯的。⇒ 這件事不可以再依賴任何人記得。
{
  const read = (p) => JSON.parse(readFileSync(_join(HERE, p), 'utf8')).version;
  const src = (readFileSync(_join(HERE, 'server.mjs'), 'utf8')
    .match(/^const VERSION = '([^']+)'/m) || [])[1];
  // 這兩個檔在 plugin 包裡才有；源碼樹單獨存在時跳過，但要出聲，不要靜默通過。
  // 兩個檔【都要在】才比得了。源碼樹有 package.json 但沒有 plugin.json ⇒ 那是「跳過」
  // 不是「不一致」——把缺檔判成失敗，就是製造一個恆紅的格子，而恆紅＝被習慣＝關掉。
  let pkg = null, plug = null;
  try { pkg = read('package.json'); } catch { }
  try { plug = read('.claude-plugin/plugin.json'); } catch { }
  if (pkg === null || plug === null)
    console.log(`  ~  版號一致性：這棵樹缺 ${pkg === null ? 'package.json' : 'plugin.json'}（源碼樹非出貨包），跳過`);
  else
    chk(`版號三處一致（server.mjs=${src} package.json=${pkg} plugin.json=${plug}）`,
        src === pkg && pkg === plug, { src, pkg, plug });
}

console.log(`\n  => ${pass} passed / ${fail} failed`);
p.kill(); process.exit(fail?1:0);
