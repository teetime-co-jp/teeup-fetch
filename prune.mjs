#!/usr/bin/env node
/**
 * 過ぎた日の行を片付ける。
 *
 * 画面が見るのは今日から先だけなので、過ぎた日のプランと日ごとの
 * 行は使い道がない。残しておくとデータベースが太るだけ。
 *
 * 値段の動きは plan_history に別に残していて、こちらは消さない。
 * 分析に使うのはそちらで、消すのは「その日に何のプランが出ていたか」
 * という、日が過ぎたら意味のなくなるほう。
 *
 * 2日ぶん余裕を持たせる。夜8時に始まる回は日付をまたぐので、
 * current_date で切ると走っている最中の書き込みと競る。
 *
 *   node prune.mjs
 */
import fs from "node:fs"
import pg from "pg"

const env = { ...process.env }
if (!env.DATABASE_URL) {
  for (const f of [".env.local", ".env"]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/DATABASE_URL=(.+)/)
      if (m) { env.DATABASE_URL = m[1].trim(); break }
    } catch { /* 無ければ次 */ }
  }
}

const c = new pg.Client({ connectionString: env.DATABASE_URL })
await c.connect()

const before = (await c.query(
  `select pg_size_pretty(pg_database_size(current_database())) as s`)).rows[0].s

const a = await c.query(`delete from plan_row where play_date < current_date - 2`)
const b = await c.query(`delete from day_plan where play_date < current_date - 2`)

const { rows: [n] } = await c.query(`
  select (select count(*) from plan_row)::int pr,
         (select count(*) from day_plan)::int dp,
         (select count(*) from plan_history)::int ph`)

console.log(`消した plan_row ${a.rowCount} ・ day_plan ${b.rowCount}`)
console.log(`残り plan_row ${n.pr.toLocaleString()} ・ day_plan ${n.dp.toLocaleString()} ・ 履歴 ${n.ph.toLocaleString()}`)
console.log(`大きさ ${before}`)
await c.end()
