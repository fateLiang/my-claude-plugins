#!/usr/bin/env bun
/**
 * inbound-store.selftest.ts — 落地/補送/保留的自檢。
 *
 * 🔑 這支測的性質，與它【測不到】的，都寫在最後一行輸出裡（沒有涵蓋到的要自己講出來）。
 */
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { recordInbound, markSurfaced, listUnsurfaced, replayMeta, prune, storeDir, type StoredInbound } from './inbound-store'

let pass = 0, fail = 0
const ok = (name: string, got: unknown, want: unknown) => {
  const good = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${good ? '✅' : '🔴'} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
  good ? pass++ : fail++
}

const mk = (over: Partial<StoredInbound> = {}): StoredInbound => ({
  update_id: 1001, content: 'hello', meta: { chat_id: '1' },
  sent: '2026-09-14T01:00:00.000Z', received: '2026-09-14T01:00:01.000Z',
  surfaced: null, ...over,
})

const D = mkdtempSync(join(tmpdir(), 'inbound-'))
try {
  console.log('— 落地與標記 —')
  const n1 = recordInbound(D, mk())
  ok('落地回傳檔名', typeof n1 === 'string' && n1!.endsWith('.json'), true)
  ok('未標記前算未送達', listUnsurfaced(D).length, 1)
  markSurfaced(D, n1, new Date('2026-09-14T01:00:02.000Z'))
  ok('標記後不再是未送達', listUnsurfaced(D).length, 0)

  console.log('— 🔻 核心性質：送不出去的那則【留得住】 —')
  const n2 = recordInbound(D, mk({ update_id: 1002, content: 'lost one' }))
  const un = listUnsurfaced(D)
  ok('沒標記 ⇒ 仍在未送達清單', un.length, 1)
  ok('內容原封保留', un[0]!.rec.content, 'lost one')
  ok('用的是【對方送出】的時間，不是收到的時間', un[0]!.rec.sent, '2026-09-14T01:00:00.000Z')

  console.log('— 補送標記必須是【結構化】的，不是文字 —')
  const rm = replayMeta(un[0]!.rec)
  ok('replay 旗標', rm.replay, 'true')
  ok('帶原始時間', rm.replay_original_ts, '2026-09-14T01:00:00.000Z')
  ok('帶 update_id 供去重', rm.replay_update_id, '1002')
  ok('🔻 程式讀得到而不必 parse 人話：replay 是獨立欄位', Object.hasOwn(rm, 'replay'), true)
  markSurfaced(D, n2)

  console.log('— 保留 7 天（以紀錄裡的 received 判斷，不是 mtime）—')
  const NOW = Date.parse('2026-09-17T00:00:00.000Z')
  recordInbound(D, mk({ update_id: 2001, received: '2026-09-16T00:00:00.000Z' })) // 1 天前
  recordInbound(D, mk({ update_id: 2002, received: '2026-09-01T00:00:00.000Z' })) // 16 天前
  ok('刪掉超過 7 天的那一則', prune(D, 7, NOW), 1)
  const left = readdirSync(storeDir(D)).filter(f => f.endsWith('.json'))
  ok('🔻 正對照：7 天內的沒有被一起刪掉', left.some(f => JSON.parse(readFileSync(join(storeDir(D), f), 'utf8')).update_id === 2001), true)

  console.log('— 🔻 壞檔不可以擋住其餘 —')
  writeFileSync(join(storeDir(D), '9999-bad.json'), '{not json')
  const n3 = recordInbound(D, mk({ update_id: 3001 }))
  ok('壞檔存在時仍列得出未送達的', listUnsurfaced(D).some(x => x.rec.update_id === 3001), true)
  ok('🔻 壞檔不被 prune 刪（刪不掉的留著比誤刪安全）', (prune(D, 0, NOW), readdirSync(storeDir(D)).includes('9999-bad.json')), true)

  console.log('— 🔻 落地失敗不可以連帶讓訊息送不出去 —')
  ok('不可寫的路徑回 null 而不是 throw', recordInbound('/proc/nonexistent-xyz', mk()), null)
  ok('markSurfaced(null) 不 throw', (markSurfaced(D, null), true), true)
} finally { rmSync(D, { recursive: true, force: true }) }

console.log(`\n${fail ? '🔴 FAIL' : '✅ ALL PASS'}  ${pass} passed, ${fail} failed`)
console.log('沒有涵蓋到的（要自己講出來）：')
console.log('  · 真的斷線 → 重啟 → 補送 的端到端：這支只測 store，surface 那一端在 server.ts')
console.log('  · 補送的訊息 agent 到底怎麼讀它：replay 旗標存在 ≠ 有人據此改變行為')
console.log('  · 併發：兩個 poller 同時寫同一個 STATE_DIR（單例假設由 server.ts 那邊保證，不在此檔）')
if (fail) process.exit(1)
