#!/usr/bin/env node
/**
 * 過ぎた日の値段を、月ごとの要約に畳む。
 *
 * 日ごとの行をそのまま貯めると、値動きの記録だけで年900MBになり、
 * Neonの1GBを1年で超える。かといって捨てると「去年の同じ時期は
 * いくらだったか」が分からなくなる。
 *
 * コース × 月 × 平日/土日祝 で1行にまとめる。
 * 1,907コース × 12ヶ月 × 2 = 年46,000行、8MBほど。10年置ける。
 *
 * 畳む先は price_month。元になるのは day_plan（その日の最安と
 * プラン数と種類）と plan_history（その日の値段が何回動いたか）。
 *
 *   node rollup.mjs
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

/* 祝日。取れなければ土日だけで分ける。年をまたいでも効くよう全部持つ */
let holidays = []
try {
  const res = await fetch("https://holidays-jp.github.io/api/v1/date.json")
  holidays = Object.keys(await res.json())
} catch { /* 土日だけで分ける */ }

await c.query(`
  create table if not exists price_month (
    course int not null references course(id) on delete cascade,
    ym date not null,
    holiday boolean not null,
    days int not null,
    min_price int, p25 int, p50 int, p75 int, max_price int,
    plans_avg numeric(6,1),
    kinds text[],
    moves_avg numeric(6,2),
    updated_at timestamptz not null default now(),
    primary key (course, ym, holiday)
  )`)
await c.query(`comment on table price_month is
  'コース×月×平日/土日祝の値段の要約。日ごとの行を畳んだもので、
   去年との比べものに使う。元の行は畳んだあと消す'`)

/*
 * 過ぎた日だけ畳む。これから先の日はまだ値段が動くので、
 * 固まってから入れる。
 */
const { rowCount: n } = await c.query(`
  insert into price_month
    (course, ym, holiday, days, min_price, p25, p50, p75, max_price,
     plans_avg, kinds, moves_avg, updated_at)
  /*
   * 日ごとの行が先。消えている日は値動きの記録から拾う。
   * 片付けのほうが先に走っても取りこぼさないようにしておく。
   * 記録のほうには種類（tags）が無いので、そこだけ空になる。
   */
  with daily as (
    select d.course, d.play_date, d.min_price, d.plans, d.tags
    from day_plan d
    where d.play_date < current_date and d.min_price is not null
    union all
    select * from (
      select distinct on (h.course, h.play_date)
             h.course, h.play_date, h.min_price, h.plans, null::text[] as tags
      from plan_history h
      where h.play_date < current_date and h.min_price is not null
        and not exists (select 1 from day_plan d2
                        where d2.course = h.course and d2.play_date = h.play_date)
      order by h.course, h.play_date, h.taken_at desc
    ) old
  ),
  src as (
    select course, play_date, min_price, plans, tags,
           date_trunc('month', play_date)::date as ym,
           (extract(dow from play_date) in (0, 6)
            or play_date = any($1::date[])) as holiday
    from daily
  ),
  moves as (
    select course, play_date, count(*)::int m from plan_history
    where play_date < current_date group by 1, 2
  )
  select s.course, s.ym, s.holiday, count(*)::int,
         min(s.min_price)::int,
         percentile_disc(0.25) within group (order by s.min_price)::int,
         percentile_disc(0.5) within group (order by s.min_price)::int,
         percentile_disc(0.75) within group (order by s.min_price)::int,
         max(s.min_price)::int,
         round(avg(s.plans), 1),
         (select array_agg(distinct t order by t)
          from src s2, unnest(s2.tags) as t
          where s2.course = s.course and s2.ym = s.ym and s2.holiday = s.holiday),
         round(avg(coalesce(mv.m, 1)), 2),
         now()
  from src s
  left join moves mv on mv.course = s.course and mv.play_date = s.play_date
  group by s.course, s.ym, s.holiday
  on conflict (course, ym, holiday) do update set
    days = excluded.days, min_price = excluded.min_price,
    p25 = excluded.p25, p50 = excluded.p50, p75 = excluded.p75,
    max_price = excluded.max_price, plans_avg = excluded.plans_avg,
    kinds = excluded.kinds, moves_avg = excluded.moves_avg,
    updated_at = now()`, [holidays])

/*
 * 畳んだぶんの値動きの記録を消す。90日は残す。
 * 直前の値下げを見たいときは生の記録が要るが、そこまで古いものは
 * 月ごとの平均回数（moves_avg）で足りる。
 */
const h = await c.query(`delete from plan_history where play_date < current_date - 90`)

const { rows: [s] } = await c.query(`
  select count(*)::int rows_, count(distinct course)::int co,
         min(ym)::text lo, max(ym)::text hi,
         pg_size_pretty(pg_total_relation_size('price_month')) as sz
  from price_month`)
console.log(`畳んだ ${n}行 ・ 値動きの記録を ${h.rowCount}行 消した`)
console.log(`price_month ${s.rows_}行 ・ ${s.co}コース ・ ${s.lo}〜${s.hi} ・ ${s.sz}`)
await c.end()
