// Nightly planner: snapshot (grid, FSRS load, resources, history) -> PLANNER role -> plan -> timed deliveries per environment.
import { sql, one, json, getLearner, plannerSnapshot } from "./db.js";
import { ask, validCode } from "./coach.js";
import { teachable } from "./grammar.js";
import { nextUnit } from "./units.js";
import { authorDrill, prerenderDrill } from "./drills.js";
import { localToUtc, localDate, localWeekday } from "./time.js";
import { updateReceptiveEstimates } from "./grade.js";

export type PlanItem =
  | { type: "unit"; resource_id: string; unit_id: number; title?: string; mode?: "study" | "replay" | "active" }
  | { type: "drill"; method: "pimsleur" | "michel_thomas" | "language_transfer"; competency_codes: string[]; minutes?: number; drill_id?: number }
  | { type: "grammar_brief"; competency_code: string }
  | { type: "listening_set" } | { type: "reading_set" }
  | { type: "writing"; task: "micro" | "tcf_w1" | "tcf_w2" | "tcf_w3" }
  | { type: "speaking"; task: "micro" | "tcf_s1" | "tcf_s2" | "tcf_s3" }
  | { type: "interview"; task: "tcf_s1" | "tcf_s3" }
  | { type: "srs"; count: number }
  | { type: "surprise_test" };

export type Plan = {
  focus: string; rationale: string; message_to_learner: string;
  slots: { environment: "patrol" | "driving" | "seated" | "micro"; slot: string; time?: string; minutes: number; items: PlanItem[] }[];
};

const CONTRACT = `Return JSON:
{"focus": one line, "rationale": 3-5 lines citing the metrics you used, "message_to_learner": 2-3 sentences (English, concrete metric, what today attacks),
 "slots":[
  {"environment":"patrol","slot":"patrol","minutes":30,"items":[...]},         // walking: unit (study) from assimil/rfi_jff/innerfrench/francais_authentique, listening_set
  {"environment":"micro","slot":"srs","minutes":8,"items":[{"type":"srs","count":15}]},   // ONE entry; repeated at each srs time
  {"environment":"driving","slot":"driving","minutes":25,"items":[...]},       // drill (required daily) + optional unit replay (assimil, mode "replay") or podcast unit
  {"environment":"seated","slot":"seated","minutes":45,"items":[...]}          // grammar_brief (max 2), writing, speaking or interview, reading_set, assimil unit mode "active"
 ]}
Item types: {"type":"unit","resource_id","unit_id","title","mode":"study|replay|active"} — unit_id and title MUST come from NEXT UNITS; {"type":"drill","method":"pimsleur|michel_thomas|language_transfer","competency_codes":[1-2 codes],"minutes":15-25}; {"type":"grammar_brief","competency_code"} — codes MUST come from TEACHABLE; {"type":"listening_set"}; {"type":"reading_set"}; {"type":"writing","task":"micro|tcf_w1|tcf_w2|tcf_w3"}; {"type":"speaking","task":"micro|tcf_s1|tcf_s2|tcf_s3"}; {"type":"interview","task":"tcf_s1|tcf_s3"}; {"type":"surprise_test"} (Sundays only).
Rules: total 120-180 min. Daily: one drill, one graded production item (writing/speaking/interview), and on patrol the next lesson unit: assimil if loaded, otherwise coach_lessons (the beginner ladder). ABSOLUTE-BEGINNER GATE: listening_set / reading_set only when that skill's CLB ≥ 3 (below that, exam-style MCQ in French is noise — use lesson units instead); tcf_* tasks only when that skill's CLB ≥ 4, else micro; interview only when speaking CLB ≥ 4. If placement is not done, keep the day light and say in message_to_learner to run /placement. Podcasts only inside their CLB band and cadence. Grammar: at most 2 competencies/day, from TEACHABLE, and the same codes should drive the drill. If fsrs_load.due_now > 40: add a second micro srs entry and say so. Sunday: lighter, plus surprise_test in seated. A unit with status 'attempted' must be retested (mode study) before a new one.`;

export async function buildPlan(forDate?: string): Promise<{ date: string; plan: Plan }> {
  const learner = await getLearner();
  const date = forDate ?? localDate(learner.tz, 1);
  await updateReceptiveEstimates();
  const snap = await plannerSnapshot();
  // make sure each active feed/course has a concrete next unit the planner can reference
  const next: any[] = [];
  const assimilLoaded = snap.unit_stats.some((u: any) => u.resource_id === "assimil");
  for (const r of snap.resources.filter((r: any) => ["course", "podcast", "news"].includes(r.kind))) {
    if (r.id === "coach_lessons" && (assimilLoaded || snap.current_clb.listening.clb >= 3)) continue;
    if (Number(r.clb_min) > snap.current_clb.listening.clb + 1) continue;   // don't ingest feeds far above level
    try { const u = await nextUnit(r.id); if (u) next.push({ resource_id: r.id, unit_id: Number(u.id), seq: u.seq, title: u.title, status: u.status, attempts: u.attempts, clb_level: u.clb_level }); } catch (e) { console.error("nextUnit", r.id, e); }
  }
  const teach = await teachable(6);
  const weekday = localWeekday(learner.tz, date);
  const daysLeft = learner.exam_date ? Math.round((new Date(learner.exam_date).getTime() - Date.now()) / 86400000) : null;

  const user = `PLAN ${weekday} ${date}. Day ${snap.days_since_start} of the programme${daysLeft ? `, ${daysLeft} days to the exam` : ", exam not booked"}.
Straight-line target CLB today: ${Math.min(7, (7 * Math.min(1, Math.max(0, snap.days_since_start) / 240))).toFixed(1)}.

LEARNER STATE:
${JSON.stringify({ current_clb: snap.current_clb, placement_done: snap.placement_done, minutes_last7: snap.minutes_last7, minutes_14d_by_environment: snap.minutes_14d_by_environment, schedule: snap.schedule, settings: snap.settings })}

GRAMMAR GRID (weakest first, with priority):
${JSON.stringify(snap.grammar_grid_weakest_first)}
TEACHABLE NOW (prerequisites met):
${JSON.stringify(teach)}

FSRS LOAD: ${JSON.stringify(snap.fsrs_load)}

RESOURCE LIBRARY:
${JSON.stringify(snap.resources)}
NEXT UNITS (the only unit_ids you may schedule):
${JSON.stringify(next)}
UNIT STATS: ${JSON.stringify(snap.unit_stats)}

RECENT HISTORY:
submissions: ${JSON.stringify(snap.recent_submissions)}
unit checks: ${JSON.stringify(snap.recent_unit_checks)}
drills: ${JSON.stringify(snap.recent_drills)}
quiz accuracy by CLB: ${JSON.stringify(snap.quiz_accuracy_by_clb)}
error patterns: ${JSON.stringify(snap.error_patterns)}
last plans: ${JSON.stringify(snap.last_plans)}
delivery outcomes (7d): ${JSON.stringify(snap.delivery_outcomes_7d)}

${CONTRACT}`;

  const plan = await ask<Plan>("PLANNER", user, { temperature: 0.35 });
  validate(plan, next, teach, snap.current_clb);
  if (!forDate) await preauthor(plan);        // nightly run only; /today and /replan stay fast
  await sql`INSERT INTO plans (plan_date, plan, inputs_digest) VALUES (${date}, ${json(plan)}::jsonb, ${json({ clb: snap.current_clb, fsrs: snap.fsrs_load, teach: teach.map((t: any) => t.code), next })}::jsonb)
            ON CONFLICT (plan_date) DO UPDATE SET plan = EXCLUDED.plan, inputs_digest = EXCLUDED.inputs_digest, created_at = now()`;
  await materialise(date, plan);
  return { date, plan };
}

function validate(plan: Plan, next: any[], teach: any[], clb: Record<string, { clb: number }>) {
  const unitIds = new Set(next.map((n) => n.unit_id));
  const codes = new Set(teach.map((t: any) => t.code));
  for (const s of plan.slots ?? []) {
    s.items = (s.items ?? []).flatMap((it): PlanItem[] => {
      if (it.type === "unit") { const n = next.find((x) => x.unit_id === it.unit_id); return n ? [{ ...it, title: n.title ?? it.title }] : []; }
      if (it.type === "grammar_brief") return codes.has(it.competency_code) ? [it] : [];
      if (it.type === "drill") {
        const cc = (it.competency_codes ?? []).filter(validCode).slice(0, 2);
        if (!cc.length) cc.push(...(teach[0] ? [teach[0].code] : []));
        if (!cc.length) return [];
        const method = ["pimsleur", "michel_thomas", "language_transfer"].includes(it.method) ? it.method : "pimsleur";
        return [{ ...it, method, competency_codes: cc, minutes: Math.min(20, Math.max(8, Number(it.minutes) || 12)) }];
      }
      if (it.type === "srs") return [{ type: "srs", count: Math.min(40, Math.max(5, Number(it.count) || 15)) }];
      if (it.type === "listening_set") return clb.listening.clb >= 3 ? [it] : [];
      if (it.type === "reading_set") return clb.reading.clb >= 3 ? [it] : [];
      if (it.type === "writing" && it.task !== "micro" && clb.writing.clb < 4) return [{ type: "writing", task: "micro" }];
      if (it.type === "speaking" && it.task !== "micro" && clb.speaking.clb < 4) return [{ type: "speaking", task: "micro" }];
      if (it.type === "interview" && clb.speaking.clb < 4) return [{ type: "speaking", task: "micro" }];
      return [it];
    });
  }
  // the patrol slot must carry a lesson unit when one is available (the planner sometimes drops it)
  const lesson = next.find((n) => n.resource_id === "assimil") ?? next.find((n) => n.resource_id === "coach_lessons");
  let patrol = plan.slots.find((s) => s.environment === "patrol");
  if (!patrol && lesson) { patrol = { environment: "patrol", slot: "patrol", minutes: 30, items: [] }; plan.slots.unshift(patrol); }
  if (patrol && lesson && !patrol.items.some((i) => i.type === "unit")) patrol.items.unshift({ type: "unit", resource_id: lesson.resource_id, unit_id: lesson.unit_id, title: lesson.title, mode: "study" });
  for (const s of plan.slots) {
    if (s.time && !/^\d{2}:\d{2}$/.test(s.time)) delete s.time;
    s.minutes = Math.max(5, Number(s.minutes) || 20);
    if (!["patrol", "driving", "seated", "micro"].includes(s.environment)) s.environment = "seated";
  }
  plan.slots = plan.slots.filter((s) => s.items.length);
  plan.focus = String(plan.focus ?? ""); plan.message_to_learner = String(plan.message_to_learner ?? "");
  if (!plan.slots?.length) throw new Error("planner returned no slots");
}

/** Nightly: author + render tomorrow's drills now so the driving delivery is instant and can't time out. */
export async function preauthor(plan: Plan) {
  for (const s of plan.slots) for (const it of s.items) {
    if (it.type !== "drill" || it.drill_id) continue;
    try { it.drill_id = await authorDrill({ method: it.method, competency_codes: it.competency_codes, minutes: it.minutes }); await prerenderDrill(it.drill_id); }
    catch (e) { console.error("preauthor drill", e); }
  }
}

/** Plan -> deliveries (replaces pending ones for that date). */
export async function materialise(date: string, plan: Plan) {
  const learner = await getLearner();
  const s = learner.schedule;
  await sql`DELETE FROM deliveries WHERE plan_date = ${date} AND status = 'pending'`;
  const already = await sql`SELECT slot, environment FROM deliveries WHERE plan_date = ${date} AND status <> 'pending'`;
  const done = new Set(already.map((r) => `${r.environment}:${r.slot}`));
  const rows: { environment: string; slot: string; at: Date; payload: any }[] = [];
  const at = (hhmm: string) => localToUtc(date, hhmm, learner.tz);
  rows.push({ environment: "micro", slot: "morning_card", at: at(s.morning_card), payload: { plan } });
  const patrolTimes: string[] = Array.isArray(s.patrol) ? s.patrol : [s.patrol];
  let patrolIdx = 0, srsExpanded = false;
  for (const sl of plan.slots) {
    if (sl.slot === "srs" || sl.environment === "micro") {
      if (!srsExpanded) { srsExpanded = true; for (const t of s.srs as string[]) rows.push({ environment: "micro", slot: "srs", at: at(t), payload: { items: sl.items, minutes: sl.minutes } }); }
      else if (sl.time) rows.push({ environment: "micro", slot: "srs", at: at(sl.time), payload: { items: sl.items, minutes: sl.minutes } });
    } else if (sl.environment === "patrol") {
      rows.push({ environment: "patrol", slot: "patrol", at: at(sl.time ?? patrolTimes[Math.min(patrolIdx++, patrolTimes.length - 1)]), payload: { items: sl.items, minutes: sl.minutes } });
    } else if (s[sl.environment]) {
      rows.push({ environment: sl.environment, slot: sl.slot, at: at(sl.time ?? s[sl.environment]), payload: { items: sl.items, minutes: sl.minutes } });
    }
  }
  rows.push({ environment: "micro", slot: "checkin", at: at(s.checkin), payload: {} });
  // Re-planning mid-day: don't re-send slots that already went out, and don't queue up a backlog of past times
  // (anything more than 20 min in the past is dropped; a re-plan for today is read with /today or the slot buttons).
  const cutoff = Date.now() - 20 * 60000;
  const fresh = rows.filter((r) => !isNaN(r.at.getTime()) && r.at.getTime() >= cutoff && !done.has(`${r.environment}:${r.slot}`));
  for (const r of fresh)
    await sql`INSERT INTO deliveries (plan_date, environment, slot, scheduled_at, payload) VALUES (${date}, ${r.environment}::environment, ${r.slot}, ${r.at.toISOString()}, ${json(r.payload)}::jsonb)`;
  return fresh.length;
}
