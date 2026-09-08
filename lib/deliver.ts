// Renders scheduled deliveries into Telegram: morning card, environment slots (one item at a time), check-in.
import { sql, one, getLearner, kvGet, kvSet } from "./db.js";
import { sendMessage, esc, type Keyboard } from "./telegram.js";
import { sendUnit } from "./units.js";
import { authorDrill, sendDrill, startSpotCheck } from "./drills.js";
import { sendListeningSet, sendReadingSet, sendWritingTask, sendSpeakingTask, startInterview, sendGrammarBrief } from "./generate.js";
import { startSession } from "./srs.js";
import { startCheck, authorSurprise } from "./checks.js";
import { competencyName, validCode } from "./coach.js";
import { startQueue, advance, itemDone, queueInfo, busy } from "./flow.js";
import type { Plan, PlanItem } from "./planner.js";

const ENV_LABEL: Record<string, string> = { patrol: "🚶 Patrol", driving: "🚗 Driving", seated: "🪑 Seated", micro: "🃏 Cards" };

export async function runDelivery(d: { id: number; slot: string; environment: string; payload: any; plan_date: string }) {
  const chatId = (await getLearner()).chat_id!;
  switch (d.slot) {
    case "morning_card": return sendMorningCard(chatId, d.plan_date, d.payload.plan as Plan);
    case "srs": return sendSrsSlot(chatId, d.payload.items?.[0]?.count ?? 15);
    case "checkin": return sendCheckin(chatId, d.plan_date);
    default: return sendSlot(chatId, d.environment, d.payload.items as PlanItem[], d.payload.minutes, d.id);
  }
}

/** Card slot: an untaken post-drive spot check goes first (cards are queued behind it). */
async function sendSrsSlot(chatId: number, count: number) {
  const spot = await kvGet<{ drill_id: number; delivery_id: number | null }>("spot_pending");
  if (spot && !(await busy())) {
    await kvSet("srs_deferred", { chatId, count }, 180);
    await sendMessage(chatId, "🚗 First, the spot check from your drive — cards right after.");
    return startSpotCheck(chatId, spot.drill_id, spot.delivery_id ?? undefined);
  }
  return startSession(chatId, count, "micro", "🃏 Card time — type the French.");
}

export async function sendMorningCard(chatId: number, date: string, plan: Plan) {
  const done = new Set((await sql`SELECT environment::text AS e FROM deliveries WHERE plan_date = ${date} AND status = 'completed'`).map((r) => r.e));
  const passedUnits = new Set((await sql`SELECT id FROM resource_units WHERE status IN ('passed','mastered')`).map((r) => Number(r.id)));
  const mark = (s: Plan["slots"][number], i: PlanItem) => (done.has(s.environment) || (i.type === "unit" && i.mode !== "replay" && passedUnits.has(i.unit_id))) ? "✅ " : "";
  const lines = plan.slots.map((s) => `${done.has(s.environment) ? "✅ " : ""}${ENV_LABEL[s.environment] ?? s.slot} · ${s.minutes} min\n${s.items.map((i) => "   • " + mark(s, i) + esc(label(i))).join("\n")}`).join("\n");
  const total = plan.slots.reduce((n, s) => n + s.minutes * (s.environment === "micro" ? 3 : 1), 0);
  const kb: Keyboard = [
    [{ text: "🚶 Patrol now", callback_data: "slot:patrol" }, { text: "🃏 Cards", callback_data: "slot:srs" }],
    [{ text: "🚗 Driving now", callback_data: "slot:driving" }, { text: "🪑 Seated now", callback_data: "slot:seated" }],
  ];
  const learner = await getLearner();
  const hint = learner.placement_done ? "" : "\n\n⚠️ Do /placement first (10 min) so the plan matches your real level.";
  const head = await roadmapLine();
  const lessonItem = plan.slots.flatMap((s) => s.items).find((i): i is Extract<PlanItem, { type: "unit" }> => i.type === "unit" && i.mode !== "replay");
  if (lessonItem) kb.unshift([{ text: "🔥 Start (2 min): just the new words", callback_data: `start2:${lessonItem.unit_id}` }]);
  await sendMessage(chatId, `☀️ <b>${date}</b> — ~${total} min\n${head}\n🎯 <i>${esc(plan.focus)}</i>\n\n${lines}\n\n${esc(plan.message_to_learner)}${hint}`, kb);
}

/** "Unit 3/40 · Stage 1 Survival & sounds · 🔥 4-day streak" */
export async function roadmapLine(): Promise<string> {
  const { CURRICULUM } = await import("./units.js");
  const passed = await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')`;
  const n = Number(passed?.n ?? 0);
  const unit = CURRICULUM.units[Math.min(n, CURRICULUM.units.length - 1)];
  const st = CURRICULUM.stages.find((x) => x.id === unit.stage);
  const days = await sql`SELECT DISTINCT log_date::text AS d FROM activity_log WHERE verified AND log_date >= CURRENT_DATE - 60`;
  const set = new Set(days.map((r) => r.d)); let streak = 0;
  for (let i = 0; i < 60; i++) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); if (set.has(d)) streak++; else if (i > 0) break; }
  return `🗺 Unit ${Math.min(n + 1, CURRICULUM.units.length)}/${CURRICULUM.units.length} · Stage ${unit.stage} ${st?.name ?? ""}${streak ? ` · 🔥 ${streak}-day streak` : ""}`;
}

/** Deliver a slot one item at a time; the next item is sent when the current one completes (or ⏭ Next item). */
export async function sendSlot(chatId: number, env: string, items: PlanItem[], minutes?: number, deliveryId?: number) {
  const existing = await queueInfo();
  if (existing?.items?.length || existing?.current) {
    await sendMessage(chatId, `⏳ You still have "${esc(label(existing.current))}" open from the ${ENV_LABEL[existing.env] ?? existing.env} slot. Finish it, tap ⏭ Next item, or /skip.`,
      [[{ text: "⏭ Next item", callback_data: "q:next" }]]);
    return;
  }
  await sendMessage(chatId, `${ENV_LABEL[env] ?? env}${minutes ? ` · ${minutes} min` : ""}\n${items.map((i) => "• " + esc(label(i))).join("\n")}\n<i>One at a time — the next arrives when you finish this one.</i>`);
  await startQueue({ chatId, env, deliveryId, items: [...items] }, sendQueued);
}

/** Send the current queue item (bound to the queue's chat/env/delivery). */
export async function sendQueued(it: PlanItem) {
  const q = await queueInfo();
  if (!q) return;
  await sendItem(q.chatId, it, q.env, q.deliveryId);
  // items with no completion event of their own advance immediately
  if (it.type === "drill") await advance(sendQueued);
}

/** Completion hook called by checks / grader / cards. Only advances when the finished thing is the current queue item. */
export async function onItemDone(kind: string) {
  const q = await queueInfo();
  const cur = q?.current?.type;
  const matches: Record<string, string[]> = {
    unit_gate: ["unit"], grammar_test: ["grammar_brief", "module"], surprise: ["surprise_test"],
    listening_set: ["listening_set", "module"], reading_set: ["reading_set", "module"],
    writing: ["writing", "module"], speaking: ["speaking", "module"], interview: ["interview", "speaking"], srs: ["srs"],
    module: ["module"], watch: ["watch"],
  };
  const ok = !!cur && (matches[kind] ?? []).includes(cur);
  await itemDone(ok ? sendQueued : async () => {}, (chatId, n) => startSession(chatId, n, "micro", "🃏 Now your queued cards."));
}

export async function sendItem(chatId: number, it: PlanItem, env: string, deliveryId?: number) {
  switch (it.type) {
    case "unit": return sendUnit(chatId, it.unit_id, env, it.mode ?? "study", deliveryId);
    case "drill": {
      const existing = it.drill_id ? await one`SELECT id FROM drills WHERE id = ${it.drill_id}` :
        await one`SELECT id FROM drills WHERE competency_codes = ${it.competency_codes} AND times_played = 0 AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 1`;
      const id = existing ? Number(existing.id) : await authorDrill({ method: it.method, competency_codes: it.competency_codes, minutes: it.minutes, unit_id: it.unit_id });
      return sendDrill(chatId, id, deliveryId);
    }
    case "grammar_brief": return sendGrammarBrief(chatId, it.competency_code, deliveryId);
    case "module": { const { runModule } = await import("./module-run.js"); return runModule(chatId, it.module_id, it.activity as any, deliveryId); }
    case "watch": { const { sendWatch } = await import("./module-run.js"); return sendWatch(chatId, deliveryId); }
    case "listening_set": return sendListeningSet(chatId, env, deliveryId);
    case "reading_set": return sendReadingSet(chatId, env, deliveryId);
    case "writing": return sendWritingTask(chatId, it.task, deliveryId);
    case "speaking": return sendSpeakingTask(chatId, it.task, deliveryId);
    case "interview": return startInterview(chatId, it.task, deliveryId);
    case "srs": return startSession(chatId, it.count, env === "micro" ? "micro" : env);
    case "surprise_test": {
      const recent = {
        units: await sql`SELECT resource_id, seq, title FROM resource_units WHERE last_used > now() - interval '21 days' ORDER BY last_used DESC LIMIT 12`,
        competencies: (await sql`SELECT competency_code FROM grammar_evidence WHERE created_at > now() - interval '21 days' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8`).map((r) => r.competency_code),
        cards: await sql`SELECT front, back FROM cards WHERE created_at > now() - interval '21 days' ORDER BY random() LIMIT 25`,
      };
      const items = await authorSurprise(recent);
      return startCheck({ chatId, type: "surprise", title: "Surprise retention test", items, env, pass_pct: 75, meta: { delivery_id: deliveryId } });
    }
  }
}

/** A day is measured against the day's target, not against attendance: 127/150 is 85% of target, not a failure. */
export async function sendCheckin(chatId: number, date: string) {
  const learner = await getLearner();
  const m = await one`SELECT COALESCE(SUM(minutes),0)::int AS mins, COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS verified FROM activity_log WHERE log_date = ${date}`;
  const d = await sql`SELECT slot, status FROM deliveries WHERE plan_date = ${date} AND slot NOT IN ('morning_card','checkin')`;
  const completed = d.filter((x) => x.status === "completed").length, sent = d.filter((x) => ["sent", "completed"].includes(x.status)).length;
  const aw = await kvGet<any>("awaiting");
  if (!aw || aw.kind === "checkin") await kvSet("awaiting", { kind: "checkin", date }, 120);   // never clobber a pending writing/speaking task
  const { CURRICULUM } = await import("./units.js");
  const passed = Number((await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')`)?.n ?? 0);
  const next = CURRICULUM.units[Math.min(passed, CURRICULUM.units.length - 1)];
  const target = Number(learner.settings?.target_minutes ?? 150);
  const done = Number(m?.verified ?? 0), pct = Math.round((done / Math.max(1, target)) * 100);
  // the 7-day average is what actually predicts the exam outcome; one short day changes nothing
  const wk = await one`SELECT COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS v, COUNT(DISTINCT log_date)::int AS days FROM activity_log WHERE log_date > ${date}::date - 7 AND log_date <= ${date}::date`;
  const avg = Math.round(Number(wk?.v ?? 0) / 7);
  const verdict = avg >= target * 0.85 ? "On trajectory." : avg >= target * 0.6 ? "Slightly under — the week still averages out." : "Under target for the week; the planner will shorten items rather than pile them up.";
  const bar = "█".repeat(Math.min(10, Math.round(pct / 10))) + "░".repeat(Math.max(0, 10 - Math.round(pct / 10)));
  await sendMessage(chatId,
    `🌙 <b>Check-in</b>\n<code>${bar}</code> <b>${done}/${target} min · ${pct}% of target</b>${m?.mins && m.mins > done ? ` (+${Number(m.mins) - done} reported)` : ""}\n` +
    `📅 7-day average ${avg} min/day — ${esc(verdict)}\n🎯 ${completed}/${sent} slots completed.\n\n` +
    `Tomorrow's first step (2 min): <i>${esc(next.first_step)}</i>\n` +
    `<i>Extra time to report? /log 25 min podcast driving. The plan lands at 06:30.</i>`,
    [[{ text: "😴 Done for today", callback_data: "checkin:done" }]]);
}

export function label(i: PlanItem | undefined): string {
  if (!i) return "";
  switch (i.type) {
    case "unit": return `${i.resource_id === "assimil" ? "Assimil" : i.resource_id === "coach_lessons" ? "Lesson" : i.resource_id}${i.title ? ` — ${i.title}` : ` #${i.unit_id}`}${i.mode && i.mode !== "study" ? ` (${i.mode})` : ""}`;
    case "drill": return i.unit_id ? `Drill in the car: this lesson's lines, prompt → pause → answer` : `Drill (${String(i.method ?? "pimsleur").replace("_", " ")}): ${(i.competency_codes ?? []).filter(validCode).map(competencyName).join(", ")}`;
    case "grammar_brief": return `Grammar: ${competencyName(i.competency_code)}`;
    case "listening_set": return "TCF listening set";
    case "reading_set": return "TCF reading set";
    case "writing": return `Writing ${i.task === "micro" ? "micro" : "TCF " + String(i.task).slice(4).toUpperCase()}`;
    case "speaking": return `Speaking ${i.task === "micro" ? "micro" : "TCF " + String(i.task).slice(4).toUpperCase()}`;
    case "interview": return `Interview (TCF ${String(i.task).slice(4).toUpperCase()})`;
    case "srs": return `${i.count} cards`;
    case "module": return `${i.module_id} ${i.name}${i.activity ? ` — ${String(i.activity).replace("_", " ")}` : ""}`;
    case "watch": return "Watch something French";
    case "surprise_test": return "Surprise retention test";
    default: return String((i as any).type ?? "item");
  }
}
