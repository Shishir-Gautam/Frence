// THE EXAM TRACK: the task-module map.
//
// A module is a reusable capability (S07 "express an opinion"), not a lesson. One module generates many lessons.
// The registry (content/modules/registry.json) is fixed, versioned and human-authored: 40 modules built from the
// CLB 2012 competency areas crossed with the fixed TCF Canada format. Nothing here asks a model what to study.
//
// Division of labour, deliberately rigid:
//   this file        picks the module, holds its state, decides when it advances   (deterministic code)
//   Gemini           executes the chosen module and evaluates the answer           (no curriculum authority)
//
// State machine — every transition is driven by counted evidence, never by a model's opinion or a self-report:
//   locked      prerequisites unmet
//   available   unlocked, never taught
//   introduced  taught once (model/comprehension seen)
//   practicing  evidence accumulating, pass rule not met
//   competent   pass rule met
//   retaining   competent, waiting on a delayed re-check (next_review)
//   mastered    re-check passed after a gap -> it survived forgetting
//   maintenance mastered and periodically spot-checked so it does not decay silently
import { sql, one, json, Raw } from "./db.js";
import registry from "../content/curriculum/task-modules.json" with { type: "json" };
// The capability axis lives in lib/modules.ts (content/curriculum/modules.json). This file is the exam axis;
// the two are complementary and the planner reads both: capability decides WHAT FRENCH, this decides WHAT TASK.

export type TaskModule = {
  id: string; component: "listening" | "reading" | "writing" | "speaking"; seq: number; name: string;
  clb_area: string; can_do: string; nclc: number; tcf_task: string | null; tcf_items: string | null;
  prereq_modules: string[]; prereq_codes: string[]; activities: string[];
  evidence: { items?: number; accuracy?: number; sessions?: number; controlled_pct?: number; spontaneous?: number; timed?: number };
  fail_signals: string[]; environments: string[]; minutes: number;
};
export type State = "locked" | "available" | "introduced" | "practicing" | "competent" | "retaining" | "mastered" | "maintenance";
export type Activity = "comprehension" | "detail_hunt" | "timed_set" | "model" | "controlled" | "spontaneous" | "timed";

export const REGISTRY = registry as { version: number; note: string; states: State[]; modules: TaskModule[] };
export const TASK_MODULES = REGISTRY.modules;
export const taskDef = (id: string) => TASK_MODULES.find((m) => m.id === id);
export const isTaskId = (id: any): id is string => typeof id === "string" && TASK_MODULES.some((m) => m.id === id);

/** Registry -> DB. Re-runnable: the registry is the source of truth for definitions, the DB only for state. */
export async function seedTaskModules() {
  for (const m of TASK_MODULES) {
    await sql`INSERT INTO task_modules (id, component, seq, name, clb_area, can_do, nclc, tcf_task, tcf_items, prereq_modules, prereq_codes, activities, evidence, fail_signals, environments, minutes)
      VALUES (${m.id}, ${m.component}::skill, ${m.seq}, ${m.name}, ${m.clb_area}, ${m.can_do}, ${m.nclc}, ${m.tcf_task}, ${m.tcf_items},
              ${m.prereq_modules}, ${m.prereq_codes}, ${json(m.activities)}::jsonb, ${json(m.evidence)}::jsonb, ${json(m.fail_signals)}::jsonb, ${m.environments}, ${m.minutes})
      ON CONFLICT (id) DO UPDATE SET component = EXCLUDED.component, seq = EXCLUDED.seq, name = EXCLUDED.name, clb_area = EXCLUDED.clb_area,
        can_do = EXCLUDED.can_do, nclc = EXCLUDED.nclc, tcf_task = EXCLUDED.tcf_task, tcf_items = EXCLUDED.tcf_items,
        prereq_modules = EXCLUDED.prereq_modules, prereq_codes = EXCLUDED.prereq_codes, activities = EXCLUDED.activities,
        evidence = EXCLUDED.evidence, fail_signals = EXCLUDED.fail_signals, environments = EXCLUDED.environments, minutes = EXCLUDED.minutes`;
    await sql`INSERT INTO task_module_state (module_id) VALUES (${m.id}) ON CONFLICT DO NOTHING`;
  }
  await unlockTasks();
  return TASK_MODULES.length;
}

/** locked -> available when prerequisite modules are competent+ and prerequisite grammar codes are >= 60%. */
export async function unlockTasks(): Promise<string[]> {
  const rows = await sql`SELECT * FROM v_task_module_board`;
  const state = new Map(rows.map((r) => [String(r.id), String(r.state) as State]));
  const mastery = new Map((await sql`SELECT competency_code, mastery_pct FROM grammar_mastery`).map((r) => [String(r.competency_code), Number(r.mastery_pct)]));
  const DONE: State[] = ["competent", "retaining", "mastered", "maintenance"];
  const opened: string[] = [];
  for (const r of rows) {
    if (state.get(String(r.id)) !== "locked") continue;
    const mods = (r.prereq_modules ?? []) as string[];
    const codes = (r.prereq_codes ?? []) as string[];
    if (!mods.every((p) => DONE.includes(state.get(p) as State))) continue;
    if (!codes.every((c) => (mastery.get(c) ?? 0) >= 60)) continue;
    await sql`UPDATE task_module_state SET state = 'available', updated_at = now() WHERE module_id = ${r.id}`;
    opened.push(String(r.id));
  }
  return opened;
}

/** The first module of each component is never locked behind grammar: something must always be startable. */
export async function ensureEntryPoints() {
  for (const c of ["listening", "reading", "writing", "speaking"])
    await sql`UPDATE task_module_state SET state = 'available', updated_at = now()
              WHERE state = 'locked' AND module_id = (SELECT id FROM task_modules WHERE component = ${c}::skill ORDER BY seq LIMIT 1)`;
}

export type Evidence = { activity: Activity; score_pct?: number; clb?: number; passed?: boolean; fail_signals?: string[]; ref?: { table: string; id: number } };

/**
 * Record one scored activity and recompute the state. Pure arithmetic on counters:
 *   receptive  competent at >= `items` items with >= `accuracy` over >= `sessions` sittings
 *   productive competent at >= `controlled_pct` on controlled work AND `spontaneous` unprompted passes AND `timed` timed passes
 * A failed timed/spontaneous attempt costs one of that counter back — competence has to hold, not just be touched once.
 */
export async function recordTaskEvidence(moduleId: string, e: Evidence) {
  const def = taskDef(moduleId);
  if (!def) return null;
  await sql`INSERT INTO task_module_evidence (module_id, activity, score_pct, clb, passed, ref_table, ref_id)
            VALUES (${moduleId}, ${e.activity}, ${e.score_pct ?? null}, ${e.clb ?? null}, ${e.passed ?? null}, ${e.ref?.table ?? null}, ${e.ref?.id ?? null})`;
  await sql`INSERT INTO task_module_state (module_id) VALUES (${moduleId}) ON CONFLICT DO NOTHING`;
  const st = await one`SELECT * FROM task_module_state WHERE module_id = ${moduleId}`;
  const receptive = def.component === "listening" || def.component === "reading";
  const ok = e.passed ?? (Number(e.score_pct ?? 0) >= (receptive ? 75 : 80));

  let controlled_n = Number(st!.controlled_n), controlled_ok = Number(st!.controlled_ok);
  let spontaneous = Number(st!.spontaneous_ok), timed = Number(st!.timed_ok);
  if (receptive) {
    // for receptive modules the "controlled" counters hold item counts: n items seen, n correct-weighted sittings
    controlled_n += Math.round(Number(e.score_pct != null ? (def.evidence.items ?? 12) / 3 : 4));
    if (ok) controlled_ok += Math.round((def.evidence.items ?? 12) / 3);
    if (e.activity === "timed_set" && ok) timed += 1;
  } else if (e.activity === "controlled" || e.activity === "model") {
    controlled_n += 1; if (ok) controlled_ok += 1;
  } else if (e.activity === "spontaneous") {
    spontaneous = ok ? spontaneous + 1 : Math.max(0, spontaneous - 1);
  } else if (e.activity === "timed") {
    timed = ok ? timed + 1 : Math.max(0, timed - 1);
  }

  const flags: Record<string, number> = { ...(st!.fail_flags ?? {}) };
  for (const f of e.fail_signals ?? []) flags[f] = (flags[f] ?? 0) + 1;

  const pass = receptive
    ? controlled_n >= (def.evidence.items ?? 12) && controlled_ok / Math.max(1, controlled_n) >= (def.evidence.accuracy ?? 0.75)
    : (controlled_n >= 2 && controlled_ok / Math.max(1, controlled_n) >= (def.evidence.controlled_pct ?? 80) / 100)
      && spontaneous >= (def.evidence.spontaneous ?? 3) && timed >= (def.evidence.timed ?? 2);

  const prev = String(st!.state) as State;
  const teaching = e.activity === "model" || e.activity === "comprehension";
  let next: State;
  switch (prev) {
    case "locked": case "available":
      next = teaching ? "introduced" : pass ? "competent" : "practicing"; break;
    case "introduced": case "practicing":
      next = pass ? "competent" : "practicing"; break;
    case "competent":
      next = "retaining"; break;                       // competence owes a delayed re-check before it counts as learned
    case "retaining":
      next = ok ? "mastered" : "practicing"; break;    // survived the gap, or did not
    case "mastered":
      next = ok ? "maintenance" : "practicing"; break;
    default:
      next = ok ? "maintenance" : "practicing";
  }

  // retention gap: competent -> re-check in 5 days, mastered -> 21 days
  const gap = next === "competent" ? 5 : next === "retaining" ? 10 : next === "mastered" ? 21 : next === "maintenance" ? 45 : null;
  await sql`UPDATE task_module_state SET state = ${next}, controlled_n = ${controlled_n}, controlled_ok = ${controlled_ok},
              spontaneous_ok = ${spontaneous}, timed_ok = ${timed}, attempts = attempts + 1,
              last_score = ${e.score_pct ?? null}, last_clb = ${e.clb ?? null}, fail_flags = ${json(flags)}::jsonb,
              introduced_at = COALESCE(introduced_at, now()), last_evidence = now(),
              next_review = ${gap ? new Raw(`CURRENT_DATE + ${gap}`) : null}, updated_at = now()
            WHERE module_id = ${moduleId}`;
  if (next !== prev && ["competent", "mastered"].includes(next)) await unlockTasks();
  return { from: prev, to: next, pass };
}

/**
 * WHAT TO WORK ON NEXT — deterministic priority, no model involved:
 *   1. a retention re-check that is due (protects what was already earned)
 *   2. the lowest-numbered unfinished module whose required level is at or below the target, weakest component first
 *   3. within a component, never more than one module in flight
 */
export async function pickTaskModule(opts: { component?: string; environment?: string; target?: number } = {}) {
  const target = opts.target ?? 7;
  const rows = await sql`SELECT * FROM v_task_module_board`;
  const clb = await currentByComponent();
  const eligible = rows.filter((r) =>
    (!opts.component || r.component === opts.component) &&
    (!opts.environment || (r.environments ?? []).includes(opts.environment)) &&
    Number(r.nclc) <= target + 1);

  const due = eligible.filter((r) => ["retaining", "mastered", "maintenance"].includes(String(r.state)) && r.next_review && new Date(r.next_review) <= new Date());
  if (due.length) return { row: due.sort((a, b) => +new Date(a.next_review) - +new Date(b.next_review))[0], reason: "retention re-check due" };

  const active = eligible.filter((r) => ["introduced", "practicing"].includes(String(r.state)));
  const fresh = eligible.filter((r) => String(r.state) === "available");
  const pool = active.length ? active : fresh;
  if (!pool.length) return null;
  // weakest component first, then registry order — the map decides the sequence, the learner model decides the emphasis
  pool.sort((a, b) => (clb[a.component] - clb[b.component]) || (Number(a.nclc) - Number(b.nclc)) || (Number(a.seq) - Number(b.seq)));
  return { row: pool[0], reason: active.length ? "in progress" : "unlocked and not yet started" };
}

async function currentByComponent(): Promise<Record<string, number>> {
  const rows = await sql`SELECT skill::text AS skill, clb FROM v_current_clb`;
  const out: Record<string, number> = { listening: 1, reading: 1, writing: 1, speaking: 1 };
  for (const r of rows) out[r.skill] = Number(r.clb);
  return out;
}

/** Which activity of the module comes next — again by counters, not by asking. */
export function nextActivity(row: any): Activity {
  const def = taskDef(String(row.id))!;
  const receptive = def.component === "listening" || def.component === "reading";
  const st = String(row.state);
  if (st === "available") return receptive ? "comprehension" : "model";
  if (receptive) {
    if (Number(row.controlled_n) < (def.evidence.items ?? 12) / 2) return "comprehension";
    if (Number(row.timed_ok) < 1 && Number(row.controlled_n) >= (def.evidence.items ?? 12)) return "timed_set";
    return "detail_hunt";
  }
  const ratio = Number(row.controlled_ok) / Math.max(1, Number(row.controlled_n));
  if (Number(row.controlled_n) < 2 || ratio < (def.evidence.controlled_pct ?? 80) / 100) return "controlled";
  if (Number(row.spontaneous_ok) < (def.evidence.spontaneous ?? 3)) return "spontaneous";
  return "timed";
}

/** The learner-facing board: what is done, what is live, what is still locked. */
export type BoardRow = TaskModule & { state: State; attempts: number; controlled_n: number; controlled_ok: number; spontaneous_ok: number; timed_ok: number; next_review: string | null };
export async function taskBoard(): Promise<BoardRow[]> {
  const rows = await sql`SELECT * FROM v_task_module_board`;
  return rows.map((r) => ({ ...(taskDef(String(r.id)) as TaskModule), ...r, state: String(r.state) as State })) as BoardRow[];
}

/** Compact module context for the executor prompt — what Gemini is allowed to know and nothing else. */
export function taskBrief(row: any, activity: Activity) {
  const def = taskDef(String(row.id))!;
  const flags = Object.entries((row.fail_flags ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `MODULE ${def.id} — ${def.name} (${def.component}, required for NCLC ${def.nclc}${def.tcf_task ? `, feeds TCF ${def.tcf_task.toUpperCase()}` : ""})
OBJECTIVE: ${def.can_do}
STATE: ${row.state} · attempts ${row.attempts ?? 0} · controlled ${row.controlled_ok ?? 0}/${row.controlled_n ?? 0} · spontaneous ${row.spontaneous_ok ?? 0}/${def.evidence.spontaneous ?? "-"} · timed ${row.timed_ok ?? 0}/${def.evidence.timed ?? "-"}
ACTIVITY TO EXECUTE: ${activity}
KNOWN FAILURE MODES for this module: ${def.fail_signals.join("; ")}
${flags.length ? `THIS LEARNER'S RECURRING FLAGS HERE: ${flags.map(([k, n]) => `${k} (${n}x)`).join("; ")}` : ""}
GRAMMAR THIS MODULE LEANS ON: ${def.prereq_codes.join(", ") || "(none specific)"}`;
}

/** The grammar that is holding a component back: codes below 60% on the next module the learner cannot open yet. */
export async function blockingCodes(component?: string): Promise<{ module_id: string; code: string; mastery: number }[]> {
  const rows = await sql`SELECT * FROM v_task_module_board WHERE state = 'locked'${component ? new Raw(` AND component = '${component}'`) : new Raw("")} ORDER BY nclc, seq`;
  const mastery = new Map((await sql`SELECT competency_code, mastery_pct FROM grammar_mastery`).map((r) => [String(r.competency_code), Number(r.mastery_pct)]));
  const out: { module_id: string; code: string; mastery: number }[] = [];
  for (const r of rows) for (const c of (r.prereq_codes ?? []) as string[]) {
    const m = mastery.get(c) ?? 0;
    if (m < 60) out.push({ module_id: String(r.id), code: c, mastery: m });
  }
  return out.sort((a, b) => a.mastery - b.mastery);
}

/** One line per component for the morning card / progress: where the training map stands. */
export async function taskMapLine(): Promise<string> {
  const rows = await sql`SELECT component::text AS component,
      COUNT(*) FILTER (WHERE state IN ('competent','retaining','mastered','maintenance'))::int AS done,
      COUNT(*)::int AS n FROM v_task_module_board GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => `${String(r.component).slice(0, 1).toUpperCase()} ${r.done}/${r.n}`).join(" · ");
}
