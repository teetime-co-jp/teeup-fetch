#!/usr/bin/env node
/**
 * 住所録のURLが使えなかったコースを、検索で引き直す。
 *
 *   node resites.mjs [件数]
 *
 * ---------------------------------------------------------------
 * sites.mjs で dead / mismatch / moved / parked になった行が相手。
 * 名前で検索して出てきた先を、sites.mjs と同じ物差しで確かめる。
 *
 * 検索で出た先も疑ってかかる。乗っ取られたドメインはコース名で
 * そのまま上位に出るので、「検索で出たから正しい」とは言えない。
 * 電話番号・郵便番号・住所・名前のうち2つが載っていて初めて本物。
 *
 * 楽天GORAやじゃらんのページは公式サイトではないので候補から外す。
 * ただし運営会社の共通サイト（アコーディア等）は公式として扱う。
 */
import fs from "node:fs"
import pg from "pg"
import { PACE, look, judge, systems } from "./sitecheck.mjs"

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
const SEARCH_GAP = 5000

/**
 * 公式サイトではないので候補にしない先。
 *
 * やっかいなのは、ゴルフ場をまとめている予約ポータルがどれも
 * 「コース名＋電話番号＋住所」を載せていることで、中身の照合だけでは
 * 本物と見分けがつかない。おまけに予約の導線も持っているので、
 * 点をつけると公式サイトより上に来てしまう。名前で弾くしかない。
 *
 * 自社サイトを持たないコースもあり、その場合はポータルしか出てこない。
 * そういう行は「見つからず」として残し、こちらで決め打ちしない。
 */
const NOT_OFFICIAL = [
  // 大手ポータル
  /gora\.golf\.rakuten/, /golf-jalan\.net/, /\bgdo\.co\.jp/, /\bjalan\.net/,
  /rakuten\.co\.jp/, /golfdigest\.co\.jp/, /\balba\.co\.jp/, /golfscale\.jp/,
  /nomaejapan\.com/, /unit-golf\.jp/, /100yardage\.com/, /golfriends\.info/,
  /golf-homepage\.com/, /golf-reserve\.jp/, /tenacity\.tokyo/, /\bybook\./,
  /veragolf\.jp/, /lab-golf\.com/, /golf100\.jp/, /golfhomez\.com/, /golfcosu\.com/,
  /golf-medley\.com/, /valuegolf\.co\.jp/, /golf-honne\.jp/, /golfcamp\.jp/,
  /mmjp\.or\.jp/, /tubaki-golf/, /golfyoyaku\.jp/,
  // 日本語ドメインのまとめサイト（ショートコース.com・薄暮プレー.net・上級者ゴルフ場.com）
  /xn--tckhh2d9h0ec|xn--udkzb6bv945ayh6a|xn--uck6czc296n2vkh37coje/,
  /golf-jyoho|golfsearch|golf-navi|golfkensaku|minhyo|hotpepper|golfpartner/,
  // 辞書・地図・口コミ・SNS・ブログ
  /wikipedia\.org/, /tabelog|retty|navitime|mapion|its-mo|goo\.ne\.jp|ekiten|jorudan/,
  /facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|note\.com/,
  /\.wixsite\.com|ameblo\.jp|hatenablog|livedoor\.jp|fc2\.com/,
  // 自治体・観光協会。電話も住所も載っているが、そこから予約はできない
  /\.lg\.jp|\.go\.jp|pref\.[a-z]+\.jp|city\.[a-z]+\.jp/,
  /kanko|kankou|kankoh|tabinet|tourism|tabi\.jp|-tour\.net/,
]

async function search(q) {
  const res = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "accept-language": "ja,en;q=0.8",
    },
  })
  if (!res.ok) return []
  const html = await res.text()
  const out = []
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/g
  let m
  while ((m = re.exec(html)) && out.length < 8) {
    let u = m[1]
    const d = u.match(/uddg=([^&]+)/)
    if (d) { try { u = decodeURIComponent(d[1]) } catch { continue } }
    if (!/^https?:/.test(u)) continue
    if (NOT_OFFICIAL.some((r) => r.test(u))) continue
    out.push(u)
  }
  return out
}

const c = new pg.Client({ connectionString: env.DATABASE_URL })
await c.connect()

const { rows } = await c.query(
  `select id, course, name, pref, tel, postal, address, url, verdict
     from course_site
    where (verdict in ('dead','mismatch','moved','parked') or url is null)
      and (note is null or note not like '検索%')
    order by id
    limit $1`, [LIMIT])

console.log(`${rows.length}件を引き直す`)

let n = 0
const tally = { 直った: 0, だめ: 0 }

for (const row of rows) {
  n++
  await new Promise((r) => setTimeout(r, SEARCH_GAP))
  let cands = []
  try {
    cands = await search(`${row.name} ${row.pref || ""} ゴルフ場 公式`)
  } catch { /* 検索が落ちたら次 */ }

  /*
   * 候補に点をつけて一番良いものを採る。
   *
   * 中身が合っているだけでは足りない。県や港湾局の施設紹介ページにも
   * 電話番号と住所は載っているが、そこから予約はできない。比較サイトが
   * 要るのは値段の出ている場所なので、予約の入口があるページを上に置く。
   */
  let best = null, bestScore = -1
  for (const u of cands.slice(0, 5)) {
    try {
      await new Promise((r) => setTimeout(r, PACE))
      const got = await look(u)
      if (got.status >= 400) continue
      const j = judge(row, got)
      if (j.verdict === "mismatch" || j.verdict === "parked") continue
      const s = systems(got.html, got.finalUrl)
      let score = j.verdict === "ok" ? 10 : 4
      score += j.matched.length
      if (s.booking.length) score += 6
      // 行き着いた先がポータルだった場合（転送でそうなることがある）
      if (NOT_OFFICIAL.some((r) => r.test(got.finalUrl))) continue
      if (score > bestScore) { bestScore = score; best = { u, got, j, s } }
      if (score >= 18) break
    } catch { /* 次の候補へ */ }
  }

  if (best) {
    const s = best.s
    await c.query(
      `update course_site set url=$2, final_url=$3, status=$4, verdict=$5, matched=$6,
              title=$7, booking=$8, booking_url=$9, note=$10, checked_at=now()
         where id=$1`,
      [row.id, best.u, best.got.finalUrl, best.got.status, best.j.verdict, best.j.matched,
       best.j.title && best.j.title.slice(0, 300), s.booking,
       s.bookingUrl && s.bookingUrl.slice(0, 500), `検索で引き直し（元: ${row.url || "なし"}）`])
    tally.直った++
  } else {
    await c.query(
      `update course_site set note=$2, checked_at=now() where id=$1`,
      [row.id, `検索でも見つからず（元: ${row.url || "なし"}）`])
    tally.だめ++
  }

  if (n % 20 === 0 || n === rows.length) console.log(`${n}/${rows.length}`, JSON.stringify(tally))
}

await c.end()
