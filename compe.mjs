#!/usr/bin/env node
/**
 * オープンコンペだけを、61日ぶん全部拾う。
 *
 * 日ごとの取り込み（dayplans.mjs）はコース単位で、61日のうち23日
 * しか見ていない。近い日を厚く見る配り方なので、31〜61日先は
 * 7日おきにしか当たらない。オープンコンペは単一日程の催しなので、
 * 当たらなかった日の開催はまるごと落ちる。実際 11/8 の関東だけで
 * 154件あったが、その日は見ていなかった。
 *
 * 楽天のプラン検索は planOpenCompe=1 でコンペだけに絞れ、areaCode で
 * 地域ごとにまとめて引ける。コース単位ではなく「日×地域」で引けば、
 * 61日ぶん全部を1日26分ほどで拾える。
 *
 * 全国を1度に引くと件数が488で頭打ちになるので、8地方に分ける。
 *
 *   node compe.mjs [使ってよい分数]
 */
import fs from "node:fs"
import pg from "pg"

const BASE = "https://openapi.rakuten.co.jp/engine/api/Gora/GoraPlanSearch/20170623"
const ORIGIN = "https://teeup-one.vercel.app"
const WAIT = 1150
const BUDGET_MIN = Number(process.argv[2] ?? process.env.BUDGET_MIN ?? 100)
/** 1つの地域・1日あたりに見るページ数の上限。取りこぼしより費用を優先 */
const MAX_PAGE = 8

const env = { ...process.env }
if (!env.RAKUTEN_APP_ID) {
  for (const f of [".env.local", ".env"]) {
    try {
      for (const l of fs.readFileSync(f, "utf8").split("\n")) {
        const m = l.match(/^([A-Z_]+)=(.*)$/)
        if (m && !env[m[1]]) env[m[1]] = m[2].trim()
      }
    } catch { /* 無ければ次 */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ymd = (d) => {
  const t = new Date(d)
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`
}

/* エリアコードは都道府県のJISコード。1度に引ける件数に上限があるので地方で割る */
const REGIONS = [
  { name: "北海道東北", codes: "1,2,3,4,5,6,7" },
  { name: "関東", codes: "8,9,10,11,12,13,14" },
  { name: "甲信越北陸", codes: "15,16,17,18,19,20" },
  { name: "東海", codes: "21,22,23,24" },
  { name: "近畿", codes: "25,26,27,28,29,30" },
  { name: "中国", codes: "31,32,33,34,35" },
  { name: "四国", codes: "36,37,38,39" },
  { name: "九州沖縄", codes: "40,41,42,43,44,45,46,47" },
]

function dates() {
  const out = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let n = 0; n <= 61; n++) {
    const d = new Date(today)
    d.setDate(d.getDate() + n)
    out.push(ymd(d))
  }
  return out
}

function flagsOf(p) {
  const t = []
  const n = String(p.planName ?? "")
  if (Number(p.lunch) > 0) t.push("昼食付")
  if (String(p.round ?? "") === "0.5R") t.push("9Hプレー")
  if (Number(p.caddie) > 0) t.push("キャディ付")
  if (Number(p.cart) > 0) t.push("乗用カートあり")
  if (Number(p.stay) > 0) t.push("宿泊付")
  if (Number(p.lesson) > 0) t.push("レッスン")
  if (Number(p.openCompe) > 0) t.push("オープンコンペ")
  if (Number(p.regularCompe) > 0) t.push("コンペ専用プラン")
  if (Number(p.assu2sum) > 0) t.push("2B保証")
  if (Number(p.playerNumMin) <= 2 && Number(p.addFee2bFlag) === 0) t.push("2B割増なし")
  if (Number(p.playerNumMin) <= 3 && Number(p.addFee3bFlag) === 0) t.push("3B割増なし")
  if (/スルー/.test(n)) t.push("スループレー")
  if (/ショート/.test(n)) t.push("ショートコース")
  if (/暑寒|寒暖|冷暖/.test(n)) t.push("暑寒対策カート")
  if (/レディー?ス|女性/.test(n)) t.push("レディース")
  if (/シニア/.test(n)) t.push("シニア")
  if (/ジュニア/.test(n)) t.push("ジュニア")
  return t
}

/** その日・その地域のコンペ。ゴルフ場ごとにプランをまとめて返す */
async function compe(codes, playDate, page) {
  const q = new URLSearchParams({
    applicationId: env.RAKUTEN_APP_ID, accessKey: env.RAKUTEN_ACCESS_KEY,
    affiliateId: env.RAKUTEN_AFFILIATE_ID ?? "", format: "json",
    areaCode: codes, playDate, planOpenCompe: "1", hits: "30", page: String(page),
  })
  for (let t = 0; t < 5; t++) {
    try {
      const res = await fetch(`${BASE}?${q}`, { headers: { Origin: ORIGIN } })
      if (res.status === 429) { await sleep(4000); continue }
      if (res.status === 404) return { pages: 0, rows: [] }   // その日は無い
      if (!res.ok) return null
      const j = await res.json()
      const rows = []
      for (const it0 of j?.Items ?? []) {
        const it = it0.Item ?? it0
        let info = it.planInfo
        if (typeof info === "string") { try { info = JSON.parse(info) } catch { info = [] } }
        for (const p0 of info ?? []) {
          const p = p0.plan ?? p0
          if (!(Number(p.openCompe) > 0)) continue
          rows.push({ gora: String(it.golfCourseId ?? ""), plan: p })
        }
      }
      return { pages: Number(j.pageCount ?? 1), rows }
    } catch { await sleep(2500 * (t + 1)) }
  }
  return null
}

const url = env.DATABASE_URL
const pool = new pg.Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30000 })
pool.on("error", () => {})
process.on("unhandledRejection", () => {})
process.on("uncaughtException", (e) => {
  if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|terminated|Connection/i.test(String(e))) return
  throw e
})
const q = async (...a) => {
  for (let t = 0; t < 4; t++) {
    try { return await pool.query(...a) } catch (e) {
      if (t === 3) throw e
      await sleep(1500 * (t + 1))
    }
  }
}

await q(`alter table plan_row add column if not exists flags text[]`)
/* 税別。楽天が basePrice（課税対象金額）を返すので、割り算で出さない */
await q(`alter table plan_row add column if not exists base_price int`)
await q(`comment on column plan_row.base_price is
  'プラン料金の税抜き。price は税抜＋消費税＋ゴルフ場利用税＋その他の合計'`)

/* 楽天のゴルフ場番号から、こちらのコースを引く */
const { rows: known } = await q(`select id, gora_id from course where gora_id is not null`)
const idOf = new Map(known.map((r) => [String(r.gora_id), r.id]))

const DATES = dates()
console.log(`オープンコンペ ${DATES.length}日 × ${REGIONS.length}地方`)
console.log(`使ってよい時間 ${BUDGET_MIN}分\n`)

const { rows: [cur] } = await q(`select course as at from fetch_cursor where key = 'compe'`)
let startAt = Number(cur?.at ?? 0)
if (startAt >= DATES.length) startAt = 0
if (startAt) console.log(`前回の続き ${startAt}日目から\n`)

const t0 = Date.now()
const over = () => (Date.now() - t0) / 60000 > BUDGET_MIN
let calls = 0, wrote = 0, unknown = 0, days = 0
let writing = Promise.resolve()

outer:
for (let i = startAt; i < DATES.length; i++) {
  const d = DATES[i]
  for (const r of REGIONS) {
    if (over()) {
      await q(`insert into fetch_cursor (key, course, updated_at) values ('compe', $1, now())
               on conflict (key) do update set course = excluded.course, updated_at = now()`, [i])
      console.log(`\n時間で区切りました。${i}日目まで。次の回が続きから拾います`)
      break outer
    }
    for (let page = 1; page <= MAX_PAGE; page++) {
      const got = await compe(r.codes, d, page)
      const waited = sleep(WAIT)
      calls++
      if (got === null) { await waited; break }

      /* 楽天を待つ1.15秒の間に書く。順番に書くと1件ごとに往復ぶん待つ */
      const rowsIn = []
      for (const { gora, plan } of got.rows) {
        const course = idOf.get(gora)
        if (!course) { unknown++; continue }
        const id = Number(plan.planId)
        if (!Number.isFinite(id)) continue
        rowsIn.push([
          course, d, id, String(plan.planName ?? "").trim() || "プラン",
          Number(plan.price) || null, String(plan.startTimeZone ?? "").trim() || null,
          Number(plan.callInfo?.stockStatus) || null, flagsOf(plan),
          Number(plan.playerNumMin) || null, Number(plan.playerNumMax) || null,
          Number(plan.basePrice) || null,
        ])
      }
      if (rowsIn.length) {
        const W = 11
        const vals = rowsIn
          .map((_, i) => `(${Array.from({ length: W }, (_, k) => `$${i * W + k + 1}`).join(",")}, now())`)
          .join(",")
        writing = writing.then(() => q(`
          insert into plan_row (course, play_date, plan_id, name, price, zone, stock,
                                flags, players_min, players_max, base_price, fetched_at)
          values ${vals}
          on conflict (course, play_date, plan_id) do update set
            name = excluded.name, price = excluded.price, zone = excluded.zone,
            stock = excluded.stock, flags = excluded.flags,
            base_price = excluded.base_price, fetched_at = now()`, rowsIn.flat())).catch(() => { /* 次の巡で拾う */ })
        wrote += rowsIn.length
      }
      await waited
      if (page >= got.pages) break
    }
  }
  days++
  if (days % 10 === 0) {
    const s = (Date.now() - t0) / 1000
    console.log(`  ${days}日 ・ ${calls}回 ・ ${wrote}件 ・ 残り${((DATES.length - i) * s / days / 60).toFixed(0)}分`)
  }
}

await writing
if (!over()) {
  await q(`insert into fetch_cursor (key, course, round_started, updated_at)
           values ('compe', 0, now(), now())
           on conflict (key) do update set course = 0, round_started = now(), updated_at = now()`)
  console.log("\n1巡おわり")
}
const { rows: [s] } = await q(`
  select count(*)::int n, count(distinct course)::int co, count(distinct play_date)::int d
  from plan_row where 'オープンコンペ' = any(flags) and play_date >= current_date`)
console.log(`${calls}回 ・ 書いた ${wrote}件 ・ 知らないコース ${unknown}件`)
console.log(`オープンコンペ ${s.n}件 ・ ${s.co}コース ・ ${s.d}日`)
await pool.end()
