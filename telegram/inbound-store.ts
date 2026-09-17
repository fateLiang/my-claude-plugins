/**
 * inbound-store.ts — 收到的訊息【先落地，再送給 session】。
 *
 * WHY：
 * 在此之前這個 plugin **對訊息本文沒有任何落地路徑** —— 全檔的 writeFileSync 只有
 * poller.log（lifecycle）、bot.pid、access.json、pending-decisions.json，以及 inbox/ 的附件。
 * 文字進來 → 直接 `mcp.notification` 丟給 session → 沒了。session 不在（MCP 斷、plugin 重啟中）
 * ⇒ **那句話永久消失，而發話端沒有任何徵兆**。
 *
 * 🔑 而 Telegram 那邊也不會替我們留：Bot API 逐字
 *   「An update is considered confirmed as soon as getUpdates is called with an offset
 *     higher than its update_id.」
 *   ⇒ **刪除的觸發不是 24 小時，是我們自己把 offset 往前推。** poller 讀到就等於簽收，
 *     不管有沒有人真的看到。所以「靠 Telegram 的 24h buffer 當儲存」由建構就不成立。
 *
 * 🔑 修法不是新機制 —— 這個 plugin 對【按鈕回答】早就做對了（server.ts 的 pendingDecisions）：
 *     answered = 使用者點了 ／ surfaced = agent 真的收到
 *   拆成兩格，就是為了 loss-proof。本檔把同一個拆法套到【訊息本文】上。
 *   📏 機制早就在，它的射程停在第一個被想到的受詞（按鈕）上。
 *
 * ⚠️ 補送不是純收益：補送的是一則【指令】。三天前的「去做 X」在重啟後浮出來，
 *    對 agent 而言與剛剛說的一模一樣。所以補送一律帶原始時間 ＋ **結構化的 replay 標記**
 *    （不是只在文字裡寫「[補送]」——下一個寫自動化的人不會去 parse 人類可讀的字串）。
 *
 * 保留 7 天。
 * ⚠️ 本檔只負責【往後】的清理，不回頭刪既有的檔案。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'

export type StoredInbound = {
  /** Telegram 的 update_id —— 補送去重用的鍵（同一則絕不重複浮出兩次）。 */
  update_id: number | null
  /** 原封轉交給 mcp.notification 的兩個欄位。存下來就是為了能原樣重放。 */
  content: string
  meta: Record<string, string>
  /** 對方【送出】的時間（Telegram date）。補送時要用它，不是補送當下。 */
  sent: string
  /** 我方收到的時間。保留期以它計算。 */
  received: string
  /** null = 還沒成功交給 session ⇒ 重啟時要補送。 */
  surfaced: string | null
}

const DIRNAME = 'inbound'

export function storeDir(stateDir: string): string {
  return join(stateDir, DIRNAME)
}

/** 檔名必須可排序且唯一：收到時間 + update_id（沒有就用亂數，仍可排序）。 */
function fileFor(rec: StoredInbound): string {
  const t = Date.parse(rec.received) || Date.now()
  const id = rec.update_id != null ? String(rec.update_id) : `x${Math.random().toString(36).slice(2, 8)}`
  return `${t}-${id}.json`
}

/**
 * 落地一則 inbound。回傳檔名（之後 markSurfaced 用）或 null（寫不進去）。
 * 🔴 絕不 throw：落地失敗不可以連帶讓訊息送不出去 —— 那會把一個「可能遺失」變成「一定遺失」。
 */
export function recordInbound(stateDir: string, rec: StoredInbound): string | null {
  try {
    const d = storeDir(stateDir)
    mkdirSync(d, { recursive: true, mode: 0o700 })
    const name = fileFor(rec)
    const tmp = join(d, name + '.tmp')
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
    renameSync(tmp, join(d, name))   // 原子落地：讀者不會看到半個檔
    return name
  } catch { return null }
}

/** 成功交給 session 之後才標記。失敗就留著 surfaced=null，下次啟動補送。 */
export function markSurfaced(stateDir: string, name: string | null, now = new Date()): void {
  if (!name) return
  try {
    const p = join(storeDir(stateDir), name)
    if (!existsSync(p)) return
    const rec = JSON.parse(readFileSync(p, 'utf8')) as StoredInbound
    rec.surfaced = now.toISOString()
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
    renameSync(tmp, p)
  } catch { /* 標不上就當沒送成功 —— 寧可補送一次（可去重），不要漏 */ }
}

/** 還沒成功交給 session 的，依收到時間由舊到新。 */
export function listUnsurfaced(stateDir: string): Array<{ name: string; rec: StoredInbound }> {
  const d = storeDir(stateDir)
  if (!existsSync(d)) return []
  const out: Array<{ name: string; rec: StoredInbound }> = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(d, f), 'utf8')) as StoredInbound
      if (!rec.surfaced) out.push({ name: f, rec })
    } catch { /* 壞檔跳過，不要讓一個壞檔擋住其餘補送 */ }
  }
  return out.sort((a, b) => (a.rec.received < b.rec.received ? -1 : 1))
}

/**
 * 補送時要疊上去的 meta。
 * 🔴 `replay` 是**結構化欄位**，不是文字裡的標記 —— 讓【程式】也分得出來，
 *    否則下一個寫自動化的人會把三天前的指令當成剛剛才說的。
 */
export function replayMeta(rec: StoredInbound): Record<string, string> {
  return {
    replay: 'true',
    replay_original_ts: rec.sent,     // 他【當時】說的時間
    replay_surfaced_ts: new Date().toISOString(), // 現在才浮出來
    ...(rec.update_id != null ? { replay_update_id: String(rec.update_id) } : {}),
  }
}

/**
 * 保留 7 天。以紀錄裡的 `received` 判斷，不用 mtime
 * （mtime 會被任何 touch/複製改掉，而 received 是這筆事實本身）。
 * @returns 刪掉幾個
 */
export function prune(stateDir: string, days = 7, now = Date.now()): number {
  const d = storeDir(stateDir)
  if (!existsSync(d)) return 0
  const cutoff = now - days * 86_400_000
  let n = 0
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    const p = join(d, f)
    try {
      const rec = JSON.parse(readFileSync(p, 'utf8')) as StoredInbound
      const t = Date.parse(rec.received)
      if (Number.isFinite(t) && t < cutoff) { rmSync(p); n++ }
    } catch { /* 壞檔不刪 —— 刪不掉的東西留著比誤刪安全 */ }
  }
  return n
}
