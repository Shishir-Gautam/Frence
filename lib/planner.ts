// Nightly planner. Two deterministic paths, no model in either (ARCHITECTURE P2 — the PLANNER prompt is gone):
//   beginner : the fixed 40-unit ladder (content/curriculum/beginner.json)
//   core     : the capability matrix (lib/modules.ts) picks the grammar, the exam-task map (lib/task-modules.ts)
//              picks the task; Gemini is called later, per item, only to EXECUTE what was already chosen.
import { sql, one, json, getLearner, currentClb } from "./db.js";
import { validCode } from "./coach.js";
import { teachable } from "./grammar.js";
import { nextUnit } from "./units.js";
import { authorDrill, prerenderDrill } from "./drills.js";
import { stage } from "./stage.js";
import { pickTaskModule, nextActivity, unlockTasks, ensureEntryPoints, blockingCodes, taskMapLine } from "./task-modules.js";
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
  | { type: "module"; module_id: string; component: string; name: string; activity?: string; minutes?: number }
  | { type: "watch" }
  | { type: "surprise_test" };

export type Plan = {
  focus: string; rationale: string; message_to_learner: string;
  slots: { environment: "patrol" | "driving" | "seated" | "micro"; slot: string; time?: string; minutes: number; items: PlanItem[] }[];
};

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
  return corePlan(date, !forDate);
}


/**
 * CORE PLAN — deterministic. No model is asked what to study, at any point (ARCHITECTURE P2).
 *
 * Two axes, both read from code:
 *   CAPABILITY (lib/modules.ts, content/curriculum/modules.json) — what French you can do. Its weakest cell
 *                picks the grammar the car drill and the seated brief attack.
 *   EXAM TASK  (lib/task-modules.ts, content/curriculum/task-modules.json) — which TCF task shape you can hold.
 *                Its scheduler picks the module; Gemini is called later only to EXECUTE that module.
 *
 * The mix shifts towards the exam as the date approaches: >120 days out (or no date) one task module a day,
 * 60-120 days two, under 60 days two plus a timed one — the language track never disappears, it just narrows.
 */
async function corePlan(date: string, nightly: boolean): Promise<{ date: string; plan: Plan }> {
  const learner = await getLearner();
  const weekday = localWeekday(learner.tz, date);
  const target = Number(learner.settings?.target_minutes ?? 150);
  const targetClb = Number(learner.target_clb ?? 7);
  const daysLeft = learner.exam_date ? Math.round((new Date(learner.exam_date).getTime() - Date.now()) / 86400000) : null;
  const examSlots = daysLeft == null || daysLeft > 120 ? 1 : daysLeft > 60 ? 2 : 3;

  await seedTaskModulesIfEmpty();
  await unlockTasks(); await ensureEntryPoints();

  const clb = await currentClb();
  const ordered = (["listening", "reading", "writing", "speaking"] as const).slice().sort((a, b) => clb[a].clb - clb[b].clb);
  const picks: any[] = [];
  for (const comp of ordered) {
    if (picks.length >= examSlots) break;
    const p = await pickTaskModule({ component: comp, target: targetClb });
    if (p) picks.push(p);
  }
  const asItem = (p: any): PlanItem[] => p ? [{ type: "module", module_id: String(p.row.id), component: String(p.row.component), name: String(p.row.name), activity: nextActivity(p.row), minutes: Number(p.row.minutes) }] : [];

  // capability axis: the weakest (module, skill) cell decides the grammar; fall back to the grid's own ranking
  let bottleneckLine = "";
  let gcode: string | undefined;
  try {
    const { bottleneck } = await import("./modules.js");
    const b = await bottleneck();
    if (b) { bottleneckLine = `${b.module.name} (${b.cell.skill})`; gcode = b.module.competency_codes.find((c: string) => validCode(c)); }
  } catch (e) { console.error("bottleneck", e); }
  const blocking = await blockingCodes();
  const teach = await teachable(6);
  if (!gcode || !teach.some((t: any) => t.code === gcode))
    gcode = blocking.find((x) => teach.some((t: any) => t.code === x.code))?.code ?? teach[0]?.code;

  // input stream on patrol: whatever the resource router has next at this level
  const next: any[] = [];
  for (const r of await sql`SELECT id, clb_min FROM resources WHERE active AND kind IN ('course','podcast','news') ORDER BY priority`) {
    if (Number(r.clb_min) > clb.listening.clb + 1) continue;
    try { const u = await nextUnit(String(r.id)); if (u) { next.push({ resource_id: r.id, unit_id: Number(u.id), title: u.title }); break; } } catch (e) { console.error("nextUnit", r.id, e); }
  }

  const receptive = picks.filter((p) => ["listening", "reading"].includes(String(p.row.component)));
  const productive = picks.filter((p) => ["writing", "speaking"].includes(String(p.row.component)));
  const patrol: PlanItem[] = [
    ...next.slice(0, 1).map((n) => ({ type: "unit" as const, resource_id: n.resource_id, unit_id: n.unit_id, title: n.title, mode: "study" as const })),
    ...receptive.flatMap((p) => asItem(p)),
  ];
  const seated: PlanItem[] = [...productive.flatMap((p) => asItem(p))];
  if (gcode) seated.push({ type: "grammar_brief", competency_code: gcode });
  if (weekday === "Sunday") seated.push({ type: "surprise_test" });

  const slots: Plan["slots"] = [
    { environment: "patrol", slot: "patrol", minutes: target >= 120 ? 35 : 25, items: patrol },
    { environment: "micro", slot: "srs", minutes: 8, items: [{ type: "srs", count: target >= 120 ? 15 : 12 }] },
    { environment: "driving", slot: "driving", minutes: target >= 120 ? 20 : 14, items: [{ type: "drill", method: "pimsleur", competency_codes: gcode ? [gcode] : ["TNS_PRESENT_IRREG"], minutes: target >= 120 ? 16 : 11 }] },
    { environment: "seated", slot: "seated", minutes: 20 + seated.length * 8, items: seated },
  ];
  if (weekday === "Saturday" || weekday === "Sunday") slots[0].items.push({ type: "watch" });

  const map = await taskMapLine();
  const lead = picks[0];
  const plan: Plan = {
    focus: lead ? `${String(lead.row.id)} — ${String(lead.row.name)} (${lead.reason})` : "Consolidation",
    rationale: `Deterministic plan, no planning call. Exam map ${map}; ${examSlots} task module${examSlots > 1 ? "s" : ""} today (${daysLeft == null ? "no exam date" : daysLeft + " days out"}). ` +
      `${bottleneckLine ? `Capability bottleneck: ${bottleneckLine}. ` : ""}${gcode ? `Grammar ${gcode}${blocking.some((b) => b.code === gcode) ? " is blocking the next task module" : ""}.` : ""}`,
    message_to_learner: `${map} on the exam map. Today: ${picks.map((p) => `${p.row.id} ${String(p.row.name).toLowerCase()}`).join(", ") || "consolidation"}${gcode ? `, and ${gcode.toLowerCase().replace(/_/g, " ")} in the car` : ""}. Nothing to choose — it arrives.`,
    slots: slots.filter((s) => s.items.length),
  };
  if (nightly) await preauthor(plan);
  await sql`INSERT INTO plans (plan_date, plan, inputs_digest) VALUES (${date}, ${json(plan)}::jsonb, ${json({ stage: "core", map, modules: picks.map((p) => p.row.id), gcode, bottleneck: bottleneckLine, days_left: daysLeft })}::jsonb)
            ON CONFLICT (plan_date) DO UPDATE SET plan = EXCLUDED.plan, inputs_digest = EXCLUDED.inputs_digest, created_at = now()`;
  await materialise(date, plan);
  return { date, plan };
}

async function seedTaskModulesIfEmpty() {
  const n = await one`SELECT COUNT(*)::int AS n FROM task_modules`;
  if (!Number(n?.n ?? 0)) { const { seedTaskModules } = await import("./task-modules.js"); await seedTaskModules(); }
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
