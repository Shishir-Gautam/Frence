// Nightly planner: snapshot (grid, FSRS load, resources, history) -> PLANNER role -> plan -> timed deliveries per environment.
import { sql, one, json, getLearner, plannerSnapshot } from "./db.js";
import { ask, validCode } from "./coach.js";
import { teachable } from "./grammar.js";
import { nextUnit } from "./units.js";
import { authorDrill, prerenderDrill } from "./drills.js";
import { stage } from "./stage.js";
import { localToUtc, localDate, localWeekday } from "./time.js";
import { updateReceptiveEstimates } from "./grade.js";

export type PlanItem =
  | { type: "unit"; resource_id: string; unit_id: number; title?: string; mode?: "study" | "replay" | "active" }
  | { type: "drill"; method: "pimsleur" | "michel_thomas" | "language_transfer"; competency_codes: string[]; minutes?: number; drill_id?: number; unit_id?: number }
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

/** Rebuild today's plan (after placement / from-zero), dropping the stale one first. */
export async function rebuildToday() {
  const learner = await getLearner();
  const today = localDate(learner.tz);
  // The day restarts: drop every delivery row for today (sent/completed included), otherwise the slot buttons
  // see yesterday's-plan rows as "already done" and materialise() skips the slots.
  await sql`DELETE FROM deliveries WHERE plan_date = ${today}`;
  return buildPlan(today);
}

export async function buildPlan(forDate?: string): Promise<{ date: string; plan: Plan }> {
  const learner = await getLearner();
  const date = forDate ?? localDate(learner.tz, 1);
  await updateReceptiveEstimates();
  try { const { recomputeAll } = await import("./modules.js"); await recomputeAll(); } catch (e) { console.error("module recompute", e); }
  if ((await stage()) === "beginner") return beginnerPlan(date, !forDate);
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

/**
 * BEGINNER SYLLABUS — deterministic, no Gemini call. From zero there is no evidence to plan from, so the day is fixed:
 *   patrol   : the next lesson (Assimil if loaded, else the coach ladder) → gate check
 *   cards    : 10 typed cards, all from lessons met so far
 *   driving  : a Pimsleur-style drill built ONLY from that lesson's lines (+ due cards)
 *   seated   : active recall of the previous lesson (EN→FR), then from lesson 3 a micro writing/speaking using only known words;
 *              from lesson 6 one grammar brief tied to the lesson's own codes, its test drawn from known material
 * No exam-format tasks, no grid-driven grammar, no podcasts.
 */
async function beginnerPlan(date: string, nightly: boolean): Promise<{ date: string; plan: Plan }> {
  const lesson = (await nextUnit("assimil")) ?? (await nextUnit("coach_lessons"));
  if (!lesson) throw new Error("no lesson unit available (coach ladder authoring failed?)");
  const prev = await one`SELECT id, seq, resource_id, title FROM resource_units WHERE resource_id = ${lesson.resource_id} AND seq < ${lesson.seq} AND status IN ('passed','mastered') ORDER BY seq DESC LIMIT 1`;
  const passedN = Number((await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')`)?.n ?? 0);
  const codes: string[] = (lesson.payload?.codes ?? []).filter(validCode).slice(0, 2);
  const weekday = localWeekday((await getLearner()).tz, date);
  const seated: PlanItem[] = [];
  if (prev) seated.push({ type: "unit", resource_id: prev.resource_id, unit_id: Number(prev.id), title: prev.title, mode: "active" });
  if (passedN >= 5 && codes.length) seated.push({ type: "grammar_brief", competency_code: codes[0] });
  if (passedN >= 2) seated.push({ type: "writing", task: "micro" });
  if (passedN >= 2) seated.push({ type: "speaking", task: "micro" });
  if (passedN >= 28) seated.push(passedN % 2 ? { type: "listening_set" } : { type: "reading_set" });   // stage 3: first exam-format items, one a day
  // 2-hour day: a second patrol block replays the previous two lessons for shadowing (the most reliable beginner
  // pronunciation/rhythm work), the drill is longer, cards are more. Set learner.settings.target_minutes (default 150).
  const target = Number((await getLearner()).settings?.target_minutes ?? 150);
  const prev2 = await sql`SELECT id, seq, resource_id, title FROM resource_units WHERE resource_id = ${lesson.resource_id} AND seq < ${lesson.seq} AND status IN ('passed','mastered') ORDER BY seq DESC LIMIT 2`;
  const patrol2: PlanItem[] = target >= 120 ? prev2.map((u) => ({ type: "unit" as const, resource_id: u.resource_id, unit_id: Number(u.id), title: u.title, mode: "replay" as const })) : [];
  const plan: Plan = {
    focus: `Beginner track — lesson ${lesson.seq}${lesson.status === "attempted" ? " (retest)" : ""}: ${lesson.title ?? ""}`,
    rationale: "Fixed beginner syllabus: no evidence yet, so no evidence-driven planning. Everything is drawn from lessons already met.",
    message_to_learner: passedN === 0
      ? `Day one. Smallest possible start: tap 🔥 Start — the new words and their audio, two minutes. The rest of the lesson follows when you're walking. First step: ${lesson.payload?.first_step ?? "say bonjour out loud."}`
      : `${passedN} lesson${passedN > 1 ? "s" : ""} passed. Today: lesson ${lesson.seq} (${lesson.payload?.goal ?? lesson.title ?? ""}) on patrol, its lines as a drill in the car, recall of lesson ${prev?.seq ?? "—"} tonight. First step: ${lesson.payload?.first_step ?? "the new words."}`,
    slots: [
      { environment: "patrol", slot: "patrol", minutes: 25, items: [{ type: "unit", resource_id: lesson.resource_id, unit_id: Number(lesson.id), title: lesson.title, mode: "study" }] },
      ...(patrol2.length ? [{ environment: "patrol" as const, slot: "patrol", minutes: 15, items: patrol2 }] : []),
      { environment: "micro", slot: "srs", minutes: 8, items: [{ type: "srs", count: passedN < 3 ? 8 : target >= 120 ? 15 : 12 }] },
      { environment: "driving", slot: "driving", minutes: target >= 120 ? 18 : 12, items: [{ type: "drill", method: "pimsleur", competency_codes: codes.length ? codes : ["TNS_PRESENT_IRREG"], minutes: target >= 120 ? 15 : 10, unit_id: Number(lesson.id) }] },
      ...(seated.length ? [{ environment: "seated" as const, slot: "seated", minutes: 20 + seated.length * 5, items: seated }] : []),
    ],
  };
  if (weekday === "Sunday" && passedN >= 6) plan.slots[plan.slots.length - 1].items.push({ type: "surprise_test" });
  if (nightly) await preauthor(plan);
  await sql`INSERT INTO plans (plan_date, plan, inputs_digest) VALUES (${date}, ${json(plan)}::jsonb, ${json({ stage: "beginner", lesson: lesson.seq, passed: passedN })}::jsonb)
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
    try { it.drill_id = await authorDrill({ method: it.method, competency_codes: it.competency_codes, minutes: it.minutes, unit_id: it.unit_id }); await prerenderDrill(it.drill_id); }
    catch (e) { console.error("preauthor drill", e); }
  }
  await prewarmRescueAudio(plan);
}

/**
 * The '🤷 Didn't catch it' rescue plays the SLOW recording, and only the study path ever caches one —
 * a lesson delivered as replay has no slow audio at all. Synthesising it at rescue time is a live
 * Gemini call, so the net breaks exactly when the quota is gone. We can't mint a Telegram file_id
 * without sending, but we CAN pre-warm tts_cache: speakDialogue() caches by sha1(style|voice|text),
 * so tomorrow's rescue becomes a cache hit and an upload, with no model call.
 */
async function prewarmRescueAudio(plan: Plan) {
  const ids = [...new Set(plan.slots.flatMap((s) => s.items).filter((i): i is Extract<PlanItem, { type: "unit" }> => i.type === "unit").map((i) => i.unit_id))];
  for (const id of ids) {
    try {
      const u = await one`SELECT audio_slow, payload FROM resource_units WHERE id = ${id}`;
      const d = u?.payload?.dialogue ?? [];
      if (!u || u.audio_slow || !d.length) continue;          // already uploaded, or nothing to speak
      const { speakDialogue } = await import("./tts.js");
      await speakDialogue(d, "slow");                          // discard the bytes; the segments are now cached
    } catch (e) { console.error("prewarm rescue audio", id, e); }
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
