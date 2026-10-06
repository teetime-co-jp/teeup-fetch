#!/usr/bin/env node
/**
 * 楽天GORAのプランを毎日取りに行く。
 *
 * 全国1,907コースを61日先まで見ると1日17時間かかる。
 * 楽天は1秒1件しか受けないので縮められない。GitHub Actions は
 * 1つの仕事が6時間で切れるため、コースを4つの組に分けて回す。
 *
 *   0  深夜2時   関東6県（526）。いちばん使うので近い時間に置く
 *   1  朝8時     東日本の残り
 *   2  昼13時    中部・近畿
 *   3  夕18時    中国・四国・九州・沖縄
 *
 * どの日を引くかは近いほど密にする。近い日ほど値段が動き、
 * 実際に予約されるのも近い日だから。
 *
 *   14日先まで   毎日
 *   15〜30日先   3日おき
 *   31〜61日先   7日おき
 *
 * 組ごとに続きの位置を持つので、時間で切れても次の日の同じ回が
 * 続きから拾う。
 *
 *   node dayplans.mjs [組] [使ってよい分数]
 */
import fs from "node:fs"
import pg from "pg"

const BASE = "https://openapi.rakuten.co.jp/engine/api/Gora/GoraPlanSearch/20170623"
const ORIGIN = "https://teeup-one.vercel.app"
const WAIT = 1150
/** どの組を引くか。0〜3 */
const GROUP = Number(process.argv[2] ?? process.env.FETCH_GROUP ?? 0)
/** 使ってよい時間。過ぎたら区切って次の回に譲る */
const BUDGET_MIN = Number(process.argv[3] ?? process.env.BUDGET_MIN ?? 280)
if (!Number.isInteger(GROUP) || GROUP < 0 || GROUP > 3) {
  console.error(`組は0〜3で指定してください（${process.argv[2]}）`)
  process.exit(1)
}

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

/**
 * 今日から何日先を引くか。
 * 近いほど密に、先へ行くほど間を空ける。
 */
function targetDates() {
  const out = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let n = 1; n <= 61; n++) {
    const step = n <= 14 ? 1 : n <= 30 ? 3 : 7
    if (n <= 14 || (n - 14) % step === 0) {
      const d = new Date(today)
      d.setDate(d.getDate() + n)
      out.push(ymd(d))
    }
  }
  return out
}

async function plans(goraId, playDate) {
  const q = new URLSearchParams({
    applicationId: env.RAKUTEN_APP_ID, accessKey: env.RAKUTEN_ACCESS_KEY,
    affiliateId: env.RAKUTEN_AFFILIATE_ID, format: "json",
    golfCourseId: goraId, playDate, hits: "30",
  })
  for (let t = 0; t < 5; t++) {
    try {
      const res = await fetch(`${BASE}?${q}`, { headers: { Origin: ORIGIN } })
      if (res.status === 429) { await sleep(4000); continue }
      if (res.status === 404) return []          // その日は出ていない
      if (!res.ok) return null
      const j = await res.json()
      const out = []
      for (const it of j?.Items ?? []) {
        let info = (it.Item ?? it).planInfo
        if (typeof info === "string") { try { info = JSON.parse(info) } catch { info = [] } }
        for (const p of info ?? []) out.push(p.plan ?? p)
      }
      return out
    } catch { await sleep(2500 * (t + 1)) }
  }
  return null
}

/**
 * そのプランが何に当たるか。楽天GORAの絞り込みに名前を揃える。
 * 旗があるものは旗で、無いものは名前で見る。
 *
 * 2B保証と割増なしは、2人や3人で行く人にとって値段に直結する。
 *   assu2sum       2B保証
 *   addFee2bFlag   2Bの割増があるか。0 なら割増なし
 *   addFee3bFlag   3Bの割増があるか
 */
function tagsOf(p) {
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
  // 旗が無いものは名前で見る
  if (/スルー/.test(n)) t.push("スループレー")
  if (/ショート/.test(n)) t.push("ショートコース")
  if (/暑寒|寒暖|冷暖/.test(n)) t.push("暑寒対策カート")
  if (/レディー?ス|女性/.test(n)) t.push("レディース")
  if (/シニア/.test(n)) t.push("シニア")
  if (/ジュニア/.test(n)) t.push("ジュニア")
  return t
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

/* 税別。楽天が basePrice（課税対象金額）を返すので、割り算で出さない */
await q(`alter table plan_row add column if not exists base_price int`)

const DATES = targetDates()
/*
 * 「プランが無い」印がついたコースも、たまに見に行く。
 *
 * 以前は plans_ok is not false で外していた。印が間違っていると
 * 二度と取りに行かないので、直る道が無かった。実際 286件のうち
 * 200件以上が、土曜2日だけ見て埋まっていただけのコースだった。
 *
 * 全部を61日ぶん引くと枠に入らないので、印のあるほうは5日だけ見る。
 * 1日でもプランが出れば印が外れ、次の回から普通に引かれる。
 */
const PROBE = DATES.filter((_, i) => i % Math.ceil(DATES.length / 5) === 0).slice(0, 5)
/** 一度も取れていないコースだけを拾う。取りこぼしの追いつき用 */
const ONLY_MISSING = process.env.ONLY_MISSING === "1"

const { rows: courses } = await q(`
  select id, gora_id, (plans_ok is false) as probe from course
  where kind = 'course' and fetch_group = $1 and gora_id is not null
    ${ONLY_MISSING ? "and not exists (select 1 from day_plan d where d.course = course.id)" : ""}
  order by id`, [GROUP])
const calls = courses.reduce((n, c) => n + (c.probe ? PROBE.length : DATES.length), 0)
const LABEL = ["2時 関東6県", "8時 東日本", "13時 中部近畿", "18時 西日本"]
console.log(`${LABEL[GROUP]}（${GROUP}組） ${courses.length}コース = ${calls.toLocaleString()}回`)
console.log(`  ふつう ${courses.filter((c) => !c.probe).length}件 × ${DATES.length}日`)
console.log(`  印つき ${courses.filter((c) => c.probe).length}件 × ${PROBE.length}日`)
if (ONLY_MISSING) console.log("  まだ一度も取れていないぶんだけ")
console.log(`使ってよい時間 ${BUDGET_MIN}分\n`)

// 前回どこまで進んだか
const KEY = `dayplan:${GROUP}`
const { rows: [cur] } = await q(`select course, play_date from fetch_cursor where key = $1`, [KEY])
let startAt = 0
/* 追いつき用の回は、いつもの巡りの位置を引き継がない。別の並びになる */
if (cur?.course && !ONLY_MISSING) {
  const i = courses.findIndex((c) => c.id === cur.course)
  if (i >= 0) startAt = i
}
if (startAt) console.log(`前回の続き ${startAt}件目から\n`)

const t0 = Date.now()
const over = () => (Date.now() - t0) / 60000 > BUDGET_MIN
let done = 0, rows = 0, gone = 0, fixed = 0

for (let i = startAt; i < courses.length; i++) {
  const c = courses[i]
  if (over()) {
    if (!ONLY_MISSING) {
      await q(`insert into fetch_cursor (key, course, updated_at) values ($1, $2, now())
               on conflict (key) do update set course = excluded.course, updated_at = now()`, [KEY, c.id])
    }
    console.log(`\n時間で区切りました。${i}件目まで。次の回が続きから拾います`)
    break
  }
  /*
   * 楽天を待つ1.15秒の間にDBへ書く。
   *
   * 順番にやると 楽天1.15秒 + DB1.35秒 = 2.5秒かかっていた。
   * 楽天の1秒1件は守ったまま、待っている間に前の回の書き込みを
   * 進める。1日あたり2.5秒が1.15秒になる。
   */
  let writing = Promise.resolve()
  /* 聞いた日数と、プランを見たか。コースごとに1回だけ書く */
  let asked = 0, seen = 0

  for (const d of (c.probe ? PROBE : DATES)) {
    const list = await plans(c.gora_id, d)
    const waited = sleep(WAIT)
    if (list === null) { await waited; continue }   // 聞けなかった。次の巡で拾う
    asked++
    if (list.length) seen++

    const prices = list.map((p) => Number(p.price)).filter((x) => Number.isFinite(x) && x > 0)
    const min = prices.length ? Math.min(...prices) : null
    const top = min ? list.find((p) => Number(p.price) === min) : null
    const tags = [...new Set(list.flatMap(tagsOf))]

    /* 前の回の書き込みが終わるのを待ってから積む。順番は保つ */
    writing = writing.then(async () => {
    await q(`
      insert into day_plan (course, play_date, min_price, plans, tags, top_name, top_zone, fetched_at)
      values ($1,$2,$3,$4,$5,$6,$7, now())
      on conflict (course, play_date) do update set
        min_price = excluded.min_price, plans = excluded.plans, tags = excluded.tags,
        top_name = excluded.top_name, top_zone = excluded.top_zone, fetched_at = now()`,
      [c.id, d, min, list.length, tags.length ? tags : null,
       top?.planName ?? null, top?.startTimeZone || null])

    // 値段が動いたときだけ積む。同じ値を貯め続けない
    await q(`
      insert into plan_history (course, play_date, min_price, plans)
      select $1,$2,$3,$4
      where not exists (
        select 1 from plan_history h
        where h.course = $1 and h.play_date = $2
          and h.min_price is not distinct from $3::int4
          and h.taken_at = (select max(taken_at) from plan_history
                            where course = $1 and play_date = $2))`,
      [c.id, d, min, list.length])

    /*
     * プラン1本ずつも残す。コース詳細の一覧に出す。
     * その日に無くなったプランは消す。前の日の残骸を出さない。
     */
    /*
     * まとめて1回で書く。1本ずつ往復していたら、1行あたり3.6秒かかって
     * 1巡10時間になった。楽天を待つ1.15秒より、DBへの往復のほうが
     * 重かった。
     */
    await q(`delete from plan_row where course = $1 and play_date = $2`, [c.id, d])
    const rowsIn = list
      .filter((p) => Number.isFinite(Number(p.planId)))
      .map((p) => [
        c.id, d, Number(p.planId), String(p.planName ?? "").trim() || "プラン",
        Number(p.price) || null, String(p.startTimeZone ?? "").trim() || null,
        Number(p.callInfo?.stockStatus) || null, tagsOf(p),
        Number(p.playerNumMin) || null, Number(p.playerNumMax) || null,
        Number(p.basePrice) || null,
      ])
    if (rowsIn.length) {
      const W = 11
      const vals = rowsIn
        .map((_, i) => `(${Array.from({ length: W }, (_, k) => `$${i * W + k + 1}`).join(",")}, now())`)
        .join(",")
      await q(`
        insert into plan_row (course, play_date, plan_id, name, price, zone, stock,
                              flags, players_min, players_max, base_price, fetched_at)
        values ${vals}
        on conflict (course, play_date, plan_id) do update set
          name = excluded.name, price = excluded.price, zone = excluded.zone,
          stock = excluded.stock, flags = excluded.flags,
          players_min = excluded.players_min, players_max = excluded.players_max,
          base_price = excluded.base_price, fetched_at = now()`, rowsIn.flat())
    }
    }).catch(() => { /* 1日ぶん落としても次の巡で拾う */ })

    await waited
    rows++
    if (!list.length) gone++
  }
  await writing

  /*
   * プランの有無は、聞いた結果として決める。
   * 1日でも出れば公開している証拠。無いほうは6日以上聞いてから決める。
   * 人気のコースは土日が埋まるので、少ない日数では判断できない。
   */
  /*
   * そのコースにある種類を、日ごとの印から作り直す。
   *
   * プレースタイルの絞り込みはこれを見ている。ここで更新しないと、
   * 日ごとのデータは全国ぶん入っているのに、絞り込みは最初に
   * 手で作った6県ぶんのままになる。実際そうなっていた。
   */
  if (asked && seen) {
    await q(`
      update course c set plan_tags = s.tags
      from (
        select array_agg(distinct tag order by tag) as tags
        from (select unnest(tags) as tag from day_plan where course = $1 and tags is not null) t
      ) s
      where c.id = $1 and s.tags is not null and c.plan_tags is distinct from s.tags`, [c.id])
  }

  if (asked) {
    if (seen) {
      await q(`update course set plans_ok = true, plans_seen_at = now(),
                 plans_checked_at = now(), plans_asked = plans_asked + $2,
                 watch = true where id = $1`, [c.id, asked])
      if (c.probe) fixed++
    } else {
      await q(`update course set plans_checked_at = now(), plans_asked = plans_asked + $2,
                 plans_ok = case
                   when plans_seen_at is not null then true
                   when plans_asked + $2 >= 6 then false
                   else plans_ok end
               where id = $1`, [c.id, asked])
    }
  }

  if (++done % 25 === 0) {
    const s = (Date.now() - t0) / 1000
    const left = (courses.length - startAt - done) * s / done / 60
    console.log(`  ${done}コース ・ ${rows}行 ・ 空 ${gone} ・ 印を外した ${fixed} ・ 残り ${left.toFixed(0)}分`)
  }
}

if (!over() && !ONLY_MISSING) {
  await q(`insert into fetch_cursor (key, course, round_started, updated_at)
           values ($1, null, now(), now())
           on conflict (key) do update set course = null, round_started = now(), updated_at = now()`, [KEY])
  console.log("\n1巡おわり")
}
const { rows: [s] } = await q(`
  select count(*)::int n, count(*) filter (where min_price is not null)::int p,
         (select count(*) from plan_history)::int h from day_plan`)
console.log(`day_plan ${s.n}行（値段あり ${s.p}）・ 履歴 ${s.h}件`)
await pool.end()
