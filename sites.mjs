#!/usr/bin/env node
/**
 * 各コースの公式サイトを1回だけ見て、本物か確かめ、予約の入口を拾う。
 *
 *   node sites.mjs [件数]
 *
 * ---------------------------------------------------------------
 * なぜ「確かめる」のが本体なのか
 *
 * 住所録の URL 列は当てにならない。ドメインが切れて別人に取られて
 * いることがある。そういう先をそのまま「公式サイト」として画面に
 * 出すと、こちらが客を知らない場所へ送ることになる。
 *
 * 検索で引き直しても同じで、乗っ取られた側がそのままコース名で
 * 上位に出る。つまり URL をどこから持ってきても、最後は中身で
 * 確かめるしかない。
 *
 * 確かめる材料はもう持っている。住所録には電話番号と郵便番号と
 * 住所が全件そろっているので、ページの中にそれが載っているかを見る。
 * 乗っ取られた先にコースの電話番号は載っていない。
 *
 * ---------------------------------------------------------------
 * 読み方
 *
 * 取ってくるのは文字だけで、ページの仕掛けは動かさない。cookie も
 * 送らないし、こちらから何かを入れることもない。1サイト1回。
 * 同じドメインを使い回しているチェーンだけは間を空ける。
 */
import fs from "node:fs"
import pg from "pg"
import { PACE, HOST_GAP, PARKED_HOST, look, judge, systems, retries } from "./sitecheck.mjs"

const env = { ...process.env }
if (!env.DATABASE_URL) {
  for (const f of [".env.local", ".env"]) {
    try {
      const m = fs.readFileSync(f, "utf8").match(/DATABASE_URL=(.+)/)
      if (m) { env.DATABASE_URL = m[1].trim(); break }
    } catch { /* 無ければ次 */ }
  }
}

const LIMIT = Number(process.argv[2] || 0) || 1e9

const c = new pg.Client({ connectionString: env.DATABASE_URL })
await c.connect()

const { rows } = await c.query(
  `select id, course, name, pref, tel, postal, address, url
     from course_site
    where url is not null and checked_at is null
    order by id
    limit $1`, [LIMIT])

console.log(`${rows.length}件`)

const lastHost = new Map()
let n = 0
const tally = {}

for (const row of rows) {
  n++
  let host = ""
  try { host = new URL(row.url).hostname } catch { /* 壊れたURL */ }

  // 同じドメインを共有しているチェーンは間を空ける
  const prev = lastHost.get(host) || 0
  const wait = Math.max(PACE, prev ? HOST_GAP - (Date.now() - prev) : 0)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastHost.set(host, Date.now())

  let verdict = "dead", matched = [], title = null, booking = [], bookingUrl = null
  let status = null, finalUrl = null, note = null
  try {
    const got = await look(row.url)
    status = got.status; finalUrl = got.finalUrl
    if (got.status >= 400) { verdict = "dead"; note = "HTTP " + got.status }
    else {
      const j = judge(row, got)
      verdict = j.verdict; matched = j.matched; title = j.title
      const s = systems(got.html, got.finalUrl)
      booking = s.booking; bookingUrl = s.bookingUrl
      // 行き先のドメインが変わっていて、中身も合わないなら乗っ取り扱い
      try {
        const a = new URL(row.url).hostname.replace(/^www\./, "")
        const b = new URL(got.finalUrl).hostname.replace(/^www\./, "")
        if (PARKED_HOST.test(b)) { verdict = "parked"; note = `${a} → ${b}` }
        else if (a !== b && verdict === "mismatch") { verdict = "moved"; note = `${a} → ${b}` }
      } catch { /* 比べられない */ }
    }
  } catch (e) {
    note = String(e.message || e).slice(0, 200)
    /*
     * 一度だけ入れ替えて試す。http のまま止まっている所、www の
     * 有無だけが違う所が多く、それで拾えるものは拾っておく。
     */
    for (const alt of retries(row.url)) {
      try {
        await new Promise((r) => setTimeout(r, PACE))
        const got = await look(alt)
        if (got.status >= 400) continue
        const j = judge(row, got)
        if (j.verdict === "mismatch") continue
        status = got.status; finalUrl = got.finalUrl
        verdict = j.verdict; matched = j.matched; title = j.title
        const s2 = systems(got.html, got.finalUrl)
        booking = s2.booking; bookingUrl = s2.bookingUrl
        note = "入れ替えで取得: " + alt
        break
      } catch { /* これもだめなら次 */ }
    }
  }

  tally[verdict] = (tally[verdict] || 0) + 1
  await c.query(
    `update course_site set final_url=$2, status=$3, verdict=$4, matched=$5,
            title=$6, booking=$7, booking_url=$8, note=$9, checked_at=now()
       where id=$1`,
    [row.id, finalUrl, status, verdict, matched, title && title.slice(0, 300),
     booking, bookingUrl && bookingUrl.slice(0, 500), note])

  if (n % 50 === 0 || n === rows.length)
    console.log(`${n}/${rows.length}`, JSON.stringify(tally))
}

await c.end()
