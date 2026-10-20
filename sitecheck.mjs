/**
 * サイトを1回見て、本物か確かめ、予約の入口を拾う部品。
 *
 * sites.mjs（住所録のURLを確かめる）と resites.mjs（壊れていたものを
 * 検索で引き直す）の両方から使う。判定の決まりを1か所に置いておかないと、
 * 片方だけ直して食い違う。
 */
export const UA = "TeeupBot/1.0 (+golf course directory check; 1 request per site)"
export const TIMEOUT = 12000
export const CAP = 1024 * 1024          // 1MB で打ち切る
export const HOST_GAP = 5000            // 同じドメインへは5秒空ける
export const PACE = 400                 // 全体では0.4秒に1本

/** 駐車中・売出し中のドメインの印。ここに当たったら中身は見ない */
export const PARKED = [
  "このドメインは", "ドメインの有効期限", "お名前.com", "sedo.com", "domain for sale",
  "buy this domain", "parked domain", "porkbun", "afternic", "hugedomains",
  "whois.jprs.jp", "domainmarket", "このウェブサイトは販売用", "expired domain",
  "default web site page", "it works!", "apache2 ubuntu default",
]

/** 期限切れドメインが飛ばされる先のかたち。ww12.example.com など */
export const PARKED_HOST = /^ww\d+\./

/** 大手チェーンの共通サイト。ここに着いたなら名前が合うだけで本物 */
export const CHAIN = [
  /(^|\.)accordiagolf\.com$/, /(^|\.)pacificgolf\.co\.jp$/, /(^|\.)pgm\.co\.jp$/,
  /(^|\.)princehotels\.co\.jp$/, /(^|\.)tokyu-golf-resort\.com$/,
  /(^|\.)taiheiyoclub\.co\.jp$/, /(^|\.)cherry-group\.jp$/, /(^|\.)unimat-golf\.jp$/,
  /(^|\.)daiwaroyalgolf\.jp$/, /(^|\.)banryugolf\.com$/, /(^|\.)rttg-golf\.jp$/, /(^|\.)rtg\.jp$/,
  /(^|\.)alpen-group\.net$/, /(^|\.)rfgr\.jp$/, /(^|\.)goldgolf\.co\.jp$/,
]

/** 予約システムの見分け。href のホスト名に当てる */
export const SYSTEMS = [
  ["firstee",   /(^|\.)firstee\.jp$/],
  ["accordia",  /(^|\.)accordiagolf\.com$/],
  ["pacific",   /(^|\.)pacificgolf\.co\.jp$|(^|\.)pgm\.co\.jp$/],
  ["gora",      /(^|\.)gora\.golf\.rakuten\.co\.jp$|(^|\.)gora\.golf\.rakuten\.com$/],
  ["jalan",     /(^|\.)golf-jalan\.net$/],
  ["gdo",       /(^|\.)gdo\.co\.jp$/],
  ["yoyaku-gc", /(^|\.)yoyaku-golf\.com$|(^|\.)golf-yoyaku\.jp$/],
  ["gorataiken",/(^|\.)golfdigest\.co\.jp$/],
  ["tee-time",  /(^|\.)tee-time\.jp$/],
  ["st-golf",   /(^|\.)st-golf\.jp$/],
  ["golfone",   /(^|\.)golfone\.jp$/],
  ["neogolf",   /(^|\.)neo-golf\.jp$|(^|\.)neogolf\.jp$/],
  ["alpha",     /(^|\.)alpha-golf\.jp$/],
  ["63cc",      /(^|\.)63cc\.jp$/],
  ["wgc",       /(^|\.)w-golf\.jp$/],
]

/** 文字をそろえる。全角半角・記号・空白を落とす */
export const flat = (s) => (s || "").normalize("NFKC")
  .replace(/[\s　・･.。,、\-ー－—‐&＆/／()（）]/g, "").toUpperCase()

/** ページから電話番号らしきものを拾って数字だけにする */
export function telsIn(text) {
  const out = new Set()
  const re = /0\d{1,4}[-－‐ー(（\s]{0,2}\d{1,4}[-－‐ー)）\s]{0,2}\d{3,4}/g
  let m
  while ((m = re.exec(text))) {
    const d = m[0].replace(/[^0-9]/g, "")
    if (d.length >= 10 && d.length <= 11) out.add(d)
  }
  return out
}

/** 郵便番号 */
export function postsIn(text) {
  const out = new Set()
  const re = /〒?\s?(\d{3})[-－‐ー\s]?(\d{4})/g
  let m
  while ((m = re.exec(text))) out.add(m[1] + m[2])
  return out
}

/** タグを落として本文だけにする */
export function strip(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
}

/** href をぜんぶ拾う */
export function hrefsIn(html, base) {
  const out = new Set()
  const re = /href\s*=\s*["']([^"']+)["']/gi
  let m
  while ((m = re.exec(html))) {
    try { out.add(new URL(m[1], base).href) } catch { /* 相対が壊れている */ }
  }
  return [...out]
}

/** 住所のうち、そのコースにしか無さそうな部分を取り出す */
export function addrCore(addr) {
  if (!addr) return ""
  // 「茨城県稲敷郡阿見町吉原3657」→「阿見町吉原3657」あたりを残す
  const m = addr.normalize("NFKC").match(/[都道府県](.+)$/)
  const tail = m ? m[1] : addr
  return flat(tail.replace(/^.{0,4}?[市区町村郡]/, ""))
}

export async function look(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: { "user-agent": UA, "accept": "text/html,*/*;q=0.8",
                 "accept-language": "ja,en;q=0.8" },
    })
    const reader = res.body?.getReader()
    let buf = new Uint8Array(0)
    if (reader) {
      while (buf.length < CAP) {
        const { done, value } = await reader.read()
        if (done) break
        const next = new Uint8Array(buf.length + value.length)
        next.set(buf); next.set(value, buf.length)
        buf = next
      }
      try { await reader.cancel() } catch { /* 済み */ }
    }
    // 文字コードは meta を見て決める。日本のゴルフ場はまだ Shift_JIS が多い
    let html = new TextDecoder("utf-8").decode(buf)
    const cs = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)
      || html.slice(0, 2000).match(/charset=["']?([\w-]+)/i)
    if (cs && !/utf-?8/i.test(cs[1])) {
      try { html = new TextDecoder(cs[1].toLowerCase()).decode(buf) } catch { /* そのまま */ }
    }
    const fin = res.url || url
    let chain = false
    try {
      const h = new URL(fin).hostname.toLowerCase()
      chain = CHAIN.some((re) => re.test(h))
    } catch { /* 比べられない */ }
    return { status: res.status, finalUrl: fin, html, chain }
  } finally { clearTimeout(timer) }
}

export function judge(row, got) {
  const text = strip(got.html)
  const low = text.toLowerCase()
  const title = (got.html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1] || "").trim()

  if (PARKED.some((p) => low.includes(p.toLowerCase())) && text.length < 4000)
    return { verdict: "parked", matched: [], title }

  const matched = []
  if (row.tel && telsIn(text).has(row.tel)) matched.push("tel")
  if (row.postal && postsIn(text).has(row.postal)) matched.push("post")
  const f = flat(text)
  if (row.name && f.includes(flat(row.name))) matched.push("name")
  else if (title && flat(title).includes(flat(row.name).slice(0, 6))) matched.push("title")
  const core = addrCore(row.address)
  if (core.length >= 6 && f.includes(core)) matched.push("addr")

  let verdict = matched.length >= 2 ? "ok" : matched.length === 1 ? "weak" : "mismatch"
  /*
   * チェーンの共通サイトは、各コースのページに電話番号も郵便番号も
   * 載せていないことがある。アコーディアやパシフィックのドメインに
   * 着いていて名前が合うなら、それは本物。
   */
  if (verdict === "weak" && (matched.includes("name") || matched.includes("title")) && got.chain)
    verdict = "ok"
  return { verdict, matched, title }
}

export function systems(html, finalUrl) {
  const found = new Set()
  let bookingUrl = null
  for (const h of hrefsIn(html, finalUrl)) {
    let host
    try { host = new URL(h).hostname.toLowerCase() } catch { continue }
    for (const [name, re] of SYSTEMS) {
      if (re.test(host)) {
        found.add(name)
        if (!bookingUrl || name === "firstee") bookingUrl = h
      }
    }
  }
  // 自社の予約ページらしきもの（同じドメインの中に reserve/yoyaku がある）
  if (!found.size) {
    const self = hrefsIn(html, finalUrl).find((h) => /reserve|yoyaku|yoyak|booking|予約/i.test(h))
    if (self) { found.add("own"); bookingUrl = self }
  }
  return { booking: [...found], bookingUrl }
}

/** 落ちたときに試す別のかたち */
export function retries(url) {
  const out = []
  try {
    const u = new URL(url)
    const other = u.protocol === "http:" ? "https:" : "http:"
    const a = new URL(url); a.protocol = other; out.push(a.href)
    const b = new URL(url)
    b.hostname = b.hostname.startsWith("www.") ? b.hostname.slice(4) : "www." + b.hostname
    out.push(b.href)
  } catch { /* 壊れたURLは諦める */ }
  return out
}

