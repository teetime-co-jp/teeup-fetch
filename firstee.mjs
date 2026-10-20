#!/usr/bin/env node
/**
 * Firstee のコースから、公式ネット予約のプランと値段を引く。
 *
 *   node firstee.mjs [件数]
 *
 * ---------------------------------------------------------------
 * なぜこれが要るのか
 *
 * Teeup を予約サービスではなく価格比較サイトとして立てるなら、
 * ポータル（楽天GORA）と自社WEB（Firstee）の値段を並べて出せないと
 * 意味がない。楽天側は dayplans.mjs で貯めているので、こちらで
 * 自社WEB側を貯める。
 *
 * ---------------------------------------------------------------
 * 負荷について
 *
 * Firstee は1ページで1ヶ月ぶんのプラン表を返す。楽天が「1コース1日で
 * 1回」なのに対し、こちらは「1コース1ヶ月で1回」なので、同じ範囲を
 * 覆うのに桁が2つ違う。61日ぶんでも1コース2回で足りる。
 *
 *   219コース × 2回 = 438回。5秒空けて 約37分。
 *
 * robots.txt に ClaudeBot / GPTBot への Crawl-delay: 5 が書いてあり、
 * ティータイム側からも「1本ずつ5秒空けてほしい」と言われている。
 * 並べず、1本ずつ、5秒空ける。/aoi-cc は Disallow なので触らない。
 *
 * ---------------------------------------------------------------
 * 読み取るもの
 *
 * プラン表は <tr> 1本が1プランで、
 *   プラン名   /{slug}/{slug}/plans/{planId}/detail へのリンク
 *   値段      data-group-price が総額、本文の「N,NNN円」が税別
 *   アイコン   img の alt とファイル名（lunch_on / caddie_off など）
 *   日付      data-col-type="date" data-date="YYYY-MM-DD" の td。
 *            中に <a> があればその日に出ているプラン。○△× が空き具合
 *
 * ログインしないと見えるのはビジター向けのプランだけ。比較に要るのは
 * ビジターの値段なので、これでいい。ログインはしない。
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

const LIMIT = Number(process.argv[2] || 0) || 1e9
const GAP = 5000                       // robots.txt の Crawl-delay
const UA = "TeeupBot/1.0 (+golf price comparison; 1 request per 5s)"
const MONTHS = 3                       // 直近1ヶ月＋先の2ヶ月
const DENY = [/^\/aoi-cc(\/|$)/]       // robots.txt の Disallow

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 予約以外の固定ページ。ここはコースの札ではない */
const NOT_SLUG = new Set(["login", "signup", "terms", "privacy", "mypage", "plans",
                          "announcements", "faq", "contact"])

/**
 * プラン表のURLの候補を作る。
 *
 * だいたい /{札}/{札} だが、運営会社がまとめて持っている所は
 * /{運営}/{コース} になる（チェリーゴルフ、リソル、岩手中央観光など）。
 * 拾ってある予約リンクが /{札}/login だったり詳細ページだったりするので、
 * 形を決め打ちせず、ありそうな順に試す。
 */
function pageUrls(bookingUrl) {
  let seg
  try { seg = new URL(bookingUrl).pathname.split("/").filter(Boolean) } catch { return [] }
  if (!seg.length) return []
  const out = []
  if (seg[1] && !NOT_SLUG.has(seg[1])) out.push(`/${seg[0]}/${seg[1]}`)
  out.push(`/${seg[0]}/${seg[0]}`)
  out.push(`/${seg[0]}`)
  return [...new Set(out)]
}

/** 文字をそろえる */
const flat = (s2) => (s2 || "").normalize("NFKC")
  .replace(/公式ネット予約|公式|ネット予約/g, "")
  .replace(/[\s　・･.。,、\-ー－—‐&＆/／()（）【】\[\]]/g, "").toUpperCase()

/** そのページが本当にそのコースのものか、題で確かめる */
function isCourse(html, name) {
  const t = (html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || ""
  const a = flat(t), b = flat(name)
  if (!a || !b) return false
  /*
   * 頭が同じだけでは足りない。「ゴルフ倶楽部大樹旭コース」と
   * 「ゴルフ倶楽部大樹豊田コース」は7文字目まで同じで、
   * 前方一致で見ていたら豊田に旭のページを当ててしまった。
   * どちらかがどちらかを丸ごと含んでいることを求める。
   */
  return a.includes(b) || b.includes(a)
}

/** プラン表のページかどうか（プランが0本でも、月の切り替えがあれば本物） */
const isPlanPage = (html) =>
  html.includes("js-month-selector") || html.includes('data-col-type="date"')

/**
 * 運営会社の入口ページから、ぶら下がっているコースの札を拾う。
 *
 * チェリーゴルフやリソルのように1つの札の下に何コースも持っている所は、
 * /{運営}/{運営} が無い。入口に並んでいるコースの中から、名前の合う
 * ものを選ぶ。
 */
function childPaths(html, root, name) {
  const found = new Map()
  const re = new RegExp(`<a[^>]+href="(/${root}/[^"/?#]+)"[^>]*>([\\s\\S]{0,200}?)</a>`, "g")
  let m
  while ((m = re.exec(html))) {
    const last = m[1].split("/").pop()
    if (NOT_SLUG.has(last)) continue
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (!found.has(m[1]) || (text && !found.get(m[1]))) found.set(m[1], text)
  }
  /*
   * リンクの文字にコース名が出ていることが多い。合うものがあれば
   * それだけを見に行く。無ければ並び順のまま、数を絞って試す。
   */
  const b = flat(name)
  const hit = [...found].filter(([, t]) => {
    const a = flat(t)
    return a && (a.includes(b) || b.includes(a))
  })
  if (hit.length) return hit.map(([p]) => p)
  return [...found.keys()]
}

/** アイコンのファイル名から、絞り込みに使える言葉を起こす */
function flagOf(alt, src) {
  const f = src.split("/").pop() || ""
  if (/caddie_on/.test(f)) return "キャディ付"
  if (/lunch_on/.test(f)) return "昼食付"
  if (/competition_on/.test(f)) return "オープンコンペ"
  if (/twosome_guarantee/.test(f)) return "2サム保証"
  if (/twosome_no_charge/.test(f)) return "2B割増なし"
  if (/stay_on/.test(f)) return "宿泊付"
  if (/fw_ok/.test(f)) return "FW乗り入れ可"
  if (/through/.test(f)) return "スルー"
  if (/^2r/.test(f)) return "2ラウンド"
  if (/cart_gps/.test(f)) return "GPSナビ付"
  if (/walk/.test(f) && alt === "カート") return "歩き"
  return null
}

/** プラン表を1枚ぶん読む */
function parse(html) {
  const out = []
  // <tr> ごとに切る。表の外の <tr> は data-col-type を含まないので落ちる
  for (const tr of html.split(/<tr[\s>]/).slice(1)) {
    if (!tr.includes('data-col-type="date"')) continue

    const nameM = tr.match(/<a[^>]+href="\/[^"]*\/plans\/(\d+)\/detail"[^>]*>([\s\S]*?)<\/a>/)
    if (!nameM) continue
    const planId = nameM[1]
    const name = nameM[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()

    const priceCell = tr.match(/data-col-type="price"[^>]*data-group-price="(\d+)"([\s\S]*?)<\/td>/)
    const price = priceCell ? Number(priceCell[1]) : null
    /*
     * 税別は赤い大きい字のほう。「総額: 7,000円」と紛れるので、
     * 「総額」が付いていない最初の金額を採る。
     */
    let basePrice = null
    if (priceCell) {
      const m = priceCell[2].match(/<p[^>]*>\s*([\d,]+)円\s*<\/p>/)
      if (m) basePrice = Number(m[1].replace(/,/g, ""))
    }

    const flags = []
    const iconRe = /<img[^>]+alt="([^"]*)"[^>]+src="([^"]+)"/g
    let im
    while ((im = iconRe.exec(tr))) {
      const f = flagOf(im[1], im[2])
      if (f && !flags.includes(f)) flags.push(f)
    }

    /*
     * 日付のます目。中に <a> があればその日に出ているプラン。
     * 記号は ● が空きあり、× が満。data-tooltip にスタート時刻が
     * 並んでいるので、空き枠が何本あるかと、いちばん早い時刻も採れる。
     */
    const days = []
    const cellRe = /<td([^>]*data-col-type="date"[^>]*)>([\s\S]*?)<\/td>/g
    let cm
    while ((cm = cellRe.exec(tr))) {
      const attrs = cm[1], body = cm[2]
      const date = (attrs.match(/data-date="(\d{4}-\d{2}-\d{2})"/) || [])[1]
      if (!date) continue
      if (!/<a /.test(body)) continue           // その日は出ていない
      /*
       * ● 空きあり / △ 残りわずか / □ その日は出ているが空き無し / × 不可。
       * □ は data-hours が空になる。「出していない日」とは別物なので残す。
       */
      const mark = (body.match(/>\s*([●○◎△▲□■×✕])\s*</) || [])[1] || null
      const hoursM = body.match(/data-hours="\[([\d,\s]*)\]"/)
      const hours = hoursM && hoursM[1].trim()
        ? hoursM[1].split(",").map((s2) => Number(s2.trim())).filter((x) => !Number.isNaN(x))
        : null
      const tip = attrs.match(/data-tooltip="([^"]*)"/)
      const slots = tip ? (tip[1].match(/&quot;\d{2}:\d{2}&quot;/g) || []).length : null
      days.push({ date, mark, hours, slots })
    }
    if (!days.length) continue
    out.push({ planId, name, price, basePrice, flags, days })
  }
  return out
}

async function look(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 20000)
  try {
    const res = await fetch(url, {
      redirect: "follow", signal: ctl.signal,
      headers: { "user-agent": UA, "accept-language": "ja", "accept": "text/html" },
    })
    return { status: res.status, html: res.status === 200 ? await res.text() : "" }
  } finally { clearTimeout(timer) }
}

const c = new pg.Client({ connectionString: env.DATABASE_URL })
await c.connect()

const { rows } = await c.query(
  `select id, course, name, booking_url
     from course_site
    where 'firstee' = any(booking)
      and booking_url like '%firstee.jp%'
      and (own_at is null or own_at < now() - interval '20 hours')
    order by own_at nulls first, id
    limit $1`, [LIMIT])

console.log(`${rows.length}コース`)

const now = new Date()
/** 今月ぶんと、その先のぶん。?month=&year= で月を指定する */
const months = []
for (let i = 0; i < MONTHS; i++) {
  const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
  months.push({ y: d.getFullYear(), m: d.getMonth() + 1 })
}

let n = 0, plans = 0, days = 0, skipped = 0
for (const row of rows) {
  n++
  const cands = pageUrls(row.booking_url)
  if (!cands.length) continue
  if (cands.some((p) => DENY.some((re) => re.test(p)))) { skipped++; continue }

  const seen = new Map()        // play_date|planId で重ねない
  let note = null, got = 0, path = null

  // どの形のURLかを1回だけ見つける
  const queue = [...cands]
  const tried = new Set()
  let root = null
  try { root = new URL(row.booking_url).pathname.split("/").filter(Boolean)[0] } catch { /* 無い */ }

  while (queue.length && !path) {
    const p = queue.shift()
    if (tried.has(p)) continue
    tried.add(p)
    await sleep(GAP)
    try {
      const res = await look(`https://firstee.jp${p}`)
      if (res.status !== 200) continue
      if (!isPlanPage(res.html)) {
        /*
         * 運営会社の入口だった。ぶら下がっているコースを後ろに積んで
         * 名前の合うものを探す。多いので6本までにしておく。
         */
        if (root) for (const cp of childPaths(res.html, root, row.name).slice(0, 8))
          if (!tried.has(cp)) queue.push(cp)
        continue
      }
      if (!isCourse(res.html, row.name)) { note = "名前の合うページが無い"; continue }
      path = p
      note = null
      for (const pl of parse(res.html)) {
        for (const d of pl.days) seen.set(`${d.date}|${pl.planId}`, { p: pl, d })
      }
      got++
    } catch (e) { note = String(e.message || e).slice(0, 120) }
  }
  if (!path) { note = note || "プラン表が見つからない" }

  // 見つかったら、残りの月を足す（最初の1枚は直近1ヶ月ぶん）
  if (path) {
    for (const { y, m } of months.slice(1)) {
      await sleep(GAP)
      try {
        const res = await look(`https://firstee.jp${path}?month=${m}&year=${y}`)
        if (res.status !== 200) continue
        got++
        for (const pl of parse(res.html)) {
          for (const d of pl.days) {
            const key = `${d.date}|${pl.planId}`
            if (!seen.has(key)) seen.set(key, { p: pl, d })
          }
        }
      } catch (e) { note = String(e.message || e).slice(0, 120) }
    }
  }

  if (seen.size) {
    const vals = [], ph = []
    let i = 0
    for (const { p, d } of seen.values()) {
      ph.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9},$${i + 10},$${i + 11},now())`)
      vals.push(row.id, row.course, d.date, p.planId, p.name, p.price, p.basePrice,
                d.mark, d.hours, d.slots, p.flags)
      i += 11
    }
    // 1回あたり 500 行ずつ
    const W = 11
    for (let k = 0; k < ph.length; k += 400) {
      const part = ph.slice(k, k + 400)
      const args = vals.slice(k * W, (k + 400) * W)
      const renum = part.map((t) => t.replace(/\$(\d+)/g, (_, d2) => "$" + (Number(d2) - k * W)))
      await c.query(
        `insert into own_row (site, course, play_date, plan_id, name, price, base_price,
                              open, hours, slots, flags, fetched_at)
         values ${renum.join(",")}
         on conflict (site, source, play_date, plan_id) do update set
           name=excluded.name, price=excluded.price, base_price=excluded.base_price,
           open=excluded.open, hours=excluded.hours, slots=excluded.slots,
           flags=excluded.flags, fetched_at=now()`, args)
    }
    plans += new Set([...seen.values()].map((x) => x.p.planId)).size
    days += seen.size
  } else if (!note) {
    note = got ? "プランの掲載なし" : "読めず"
  }

  await c.query(
    `update course_site set own_at=now(), own_note=$2,
            booking_url=coalesce($3, booking_url) where id=$1`,
    [row.id, note, path ? `https://firstee.jp${path}` : null])
  if (n % 20 === 0 || n === rows.length)
    console.log(`${n}/${rows.length}  プラン${plans} 日${days} 飛ばし${skipped}`)
}

await c.end()
