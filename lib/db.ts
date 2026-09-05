// Postgres access via `pg`. Works with Neon (sslmode=require), Supabase, or a local Postgres.
// `sql` is a tagged template: sql`SELECT * FROM cards WHERE id = ${id}` -> parameterised query.
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL missing");

const pool = new pg.Pool({
  connectionString: url,
  max: 3,
  ssl: /neon\.tech|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  idleTimeoutMillis: 10_000,
});

export type Row = Record<string, any>;

export async function sql(strings: TemplateStringsArray, ...values: any[]): Promise<Row[]> {
  let text = "";
  const params: any[] = [];
  strings.forEach((s, i) => {
    text += s;
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Raw) text += v.text;
      else { params.push(Array.isArray(v) && v.length && typeof v[0] === "object" && !(v[0] instanceof Date) ? JSON.stringify(v) : v); text += `$${params.length}`; }
    }
  });
  const r = await pool.query(text, params);
  return r.rows;
}
export async function query(text: string, params: any[] = []): Promise<Row[]> {
  return (await pool.query(text, params)).rows;
}
export async function one(strings: TemplateStringsArray, ...values: any[]): Promise<Row | undefined> {
  return (await sql(strings, ...values))[0];
}
/** Unescaped SQL fragment (use only with literals you control). */
export class Raw { constructor(public text: string) {} }
export const raw = (t: string) => new Raw(t);
export const json = (v: any) => JSON.stringify(v);   // pass as ${json(x)}::jsonb

// ----------------------------------------------------------------- learner
export type Learner = {
  chat_id: number | null; tz: string; start_date: string; exam_date: string | null; target_clb: number;
  placement_done: boolean; schedule: Record<string, any>; settings: Record<string, any>;
};
export async function getLearner(): Promise<Learner> {
  const l = await one`SELECT * FROM learner WHERE id = 1`;
  if (!l) throw new Error("learner row missing — run /api/setup");
  return { ...l, chat_id: l.chat_id ? Number(l.chat_id) : null } as Learner;
}

export async function currentClb(): Promise<Record<string, { clb: number; confidence: number }>> {
  const rows = await sql`SELECT skill, clb, confidence FROM v_current_clb`;
  const out: Record<string, { clb: number; confidence: number }> = { listening: { clb: 1, confidence: 0 }, reading: { clb: 1, confidence: 0 }, writing: { clb: 1, confidence: 0 }, speaking: { clb: 1, confidence: 0 } };
  for (const r of rows) out[r.skill] = { clb: Number(r.clb), confidence: Number(r.confidence) };
  return out;
}
export async function setClb(skill: string, clb: number, confidence: number, basis: any) {
  await sql`INSERT INTO skill_estimates (skill, clb, confidence, basis) VALUES (${skill}::skill, ${clb}, ${confidence}, ${json(basis)}::jsonb)`;
}

// ---------------------------------------------------------------------- kv
export async function kvGet<T = any>(k: string): Promise<T | null> {
  const r = await one`SELECT v FROM kv WHERE k = ${k} AND (expires_at IS NULL OR expires_at > now())`;
  return r ? (r.v as T) : null;
}
export async function kvSet(k: string, v: any, ttlMinutes?: number) {
  const exp = ttlMinutes ? new Date(Date.now() + ttlMinutes * 60000).toISOString() : null;
  await sql`INSERT INTO kv (k, v, expires_at, updated_at) VALUES (${k}, ${json(v)}::jsonb, ${exp}, now())
            ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, expires_at = EXCLUDED.expires_at, updated_at = now()`;
}
export async function kvDel(k: string) { await sql`DELETE FROM kv WHERE k = ${k}`; }

// --------------------------------------------------------------- activity
export async function logActivity(date: string, environment: string, activity: string, minutes: number, verified = false, ref?: { table: string; id: number }) {
  await sql`INSERT INTO activity_log (log_date, environment, activity, minutes, verified, ref_table, ref_id)
            VALUES (${date}, ${environment}::environment, ${activity}, ${minutes}, ${verified}, ${ref?.table ?? null}, ${ref?.id ?? null})`;
}
export async function bumpErrorPattern(category: string, kind: string, example?: string) {
  await sql`INSERT INTO error_patterns (category, kind, example) VALUES (${category}, ${kind}, ${example ?? null})
            ON CONFLICT (category) DO UPDATE SET count = error_patterns.count + 1, last_seen = now(), example = COALESCE(EXCLUDED.example, error_patterns.example)`;
}

// ------------------------------------------------------------ snapshot ---
/** Everything the PLANNER needs, compact. ~10-20k tokens. */
export async function plannerSnapshot() {
  const learner = await getLearner();
  const clb = await currentClb();
  const daysIn = Math.floor((Date.now() - new Date(learner.start_date).getTime()) / 86400000);
  const grid = await sql`SELECT code, name, family, clb_needed, exam_weight, mastery_pct, confidence, status, last_evidence::date AS last_evidence, priority::numeric(6,2) AS priority FROM v_grammar_weakest LIMIT 44`;
  const fsrs = await one`SELECT * FROM v_fsrs_load`;
  const resources = await sql`SELECT id, title, kind, environments, skills, clb_min, clb_max, minutes_per_unit, priority, cadence_rule FROM resources WHERE active`;
  const nextUnits = await sql`
    SELECT DISTINCT ON (resource_id) resource_id, id AS unit_id, seq, title, status, attempts, best_score
    FROM resource_units WHERE status IN ('unseen','scheduled','attempted') ORDER BY resource_id, seq NULLS LAST, id`;
  const unitStats = await sql`SELECT resource_id, status, COUNT(*)::int AS n FROM resource_units GROUP BY resource_id, status`;
  const minutes = await sql`
    SELECT environment, SUM(minutes)::int AS minutes, SUM(minutes) FILTER (WHERE verified)::int AS verified
    FROM activity_log WHERE log_date >= CURRENT_DATE - 13 GROUP BY environment`;
  const [m7] = await sql`SELECT COALESCE(SUM(minutes),0)::int AS m FROM activity_log WHERE log_date >= CURRENT_DATE - 6`;
  const subs = await sql`SELECT skill, task_type, clb_sub, score_20, graded_at::date AS d FROM submissions WHERE graded_at IS NOT NULL ORDER BY graded_at DESC LIMIT 12`;
  const checks = await sql`SELECT uc.check_type, uc.score_pct, uc.passed, ru.resource_id, ru.seq, uc.created_at::date AS d
    FROM unit_checks uc JOIN resource_units ru ON ru.id = uc.unit_id ORDER BY uc.created_at DESC LIMIT 10`;
  const drillsRecent = await sql`SELECT d.method, d.competency_codes, ds.score_pct, ds.played_at::date AS d FROM drill_sessions ds JOIN drills d ON d.id = ds.drill_id ORDER BY ds.played_at DESC LIMIT 7`;
  const quiz = await sql`SELECT skill, ROUND(item_clb) AS clb, COUNT(*)::int AS n, ROUND(AVG(CASE WHEN correct THEN 1 ELSE 0 END)::numeric, 2) AS acc
    FROM quiz_results WHERE created_at >= now() - interval '21 days' GROUP BY skill, ROUND(item_clb) ORDER BY skill, clb`;
  const errors = await sql`SELECT category, kind, count FROM error_patterns ORDER BY count DESC, last_seen DESC LIMIT 10`;
  const lastPlans = await sql`SELECT plan_date, plan->>'focus' AS focus FROM plans ORDER BY plan_date DESC LIMIT 7`;
  const skipped = await sql`SELECT slot, status, COUNT(*)::int AS n FROM deliveries WHERE plan_date >= CURRENT_DATE - 6 AND status IN ('skipped','stale','failed','sent') GROUP BY slot, status`;
  return {
    today: new Date().toISOString().slice(0, 10), days_since_start: daysIn, exam_date: learner.exam_date, target_clb: learner.target_clb,
    placement_done: learner.placement_done, current_clb: clb, schedule: learner.schedule, settings: learner.settings,
    grammar_grid_weakest_first: grid, fsrs_load: fsrs,
    resources, next_units: nextUnits, unit_stats: unitStats,
    minutes_14d_by_environment: minutes, minutes_last7: m7.m,
    recent_submissions: subs, recent_unit_checks: checks, recent_drills: drillsRecent,
    quiz_accuracy_by_clb: quiz, error_patterns: errors, last_plans: lastPlans, delivery_outcomes_7d: skipped,
  };
}
