// Renders scheduled deliveries into Telegram: morning card, environment slots, check-in, weekly.
import { sql, one, getLearner, kvSet } from "./db.js";
import { sendMessage, esc, type Keyboard } from "./telegram.js";
import { sendUnit } from "./units.js";
import { authorDrill, sendDrill } from "./drills.js";
import { sendListeningSet, sendReadingSet, sendWritingTask, sendSpeakingTask, startInterview, sendGrammarBrief } from "./generate.js";
import { startSession } from "./srs.js";
import { startCheck, authorSurprise } from "./checks.js";
import { competencyName } from "./coach.js";
import type { Plan, PlanItem } from "./planner.js";

const ENV_LABEL: Record<string, string> = { patrol: "🚶 Patrol", driving: "🚗 Driving", seated: "🪑 Seated", micro: "🃏 Cards" };

export async function runDelivery(d: { id: number; slot: string; environment: string; payload: any; plan_date: string }) {
  const chatId = (await getLearner()).chat_id!;
  switch (d.slot) {
    case "morning_card": return sendMorningCard(chatId, d.plan_date, d.payload.plan as Plan);
    case "srs": return startSession(chatId, d.payload.items?.[0]?.count ?? 15, "micro", "🃏 Card time — type the French.");
    case "checkin": return sendCheckin(chatId, d.plan_date);
    default: return sendSlot(chatId, d.environment, d.payload.items as PlanItem[], d.payload.minutes, d.id);
  }
}

export async function sendMorningCard(chatId: number, date: string, plan: Plan) {
  const lines = plan.slots.map((s) => `${ENV_LABEL[s.environment] ?? s.slot} · ${s.minutes} min\n${s.items.map((i) => "   • " + esc(label(i))).join("\n")}`).join("\n");
  const total = plan.slots.reduce((n, s) => n + s.minutes * (s.environment === "micro" ? 3 : 1), 0);
  const kb: Keyboard = [
    [{ text: "🚶 Patrol now", callback_data: "slot:patrol" }, { text: "🃏 Cards", callback_data: "slot:srs" }],
    [{ text: "🚗 Driving now", callback_data: "slot:driving" }, { text: "🪑 Seated now", callback_data: "slot:seated" }],
  ];
  await sendMessage(chatId, `☀️ <b>Plan du ${date}</b> — ~${total} min\n🎯 <i>${esc(plan.focus)}</i>\n\n${lines}\n\n${esc(plan.message_to_learner)}`, kb);
}

export async function sendSlot(chatId: number, env: string, items: PlanItem[], minutes?: number, deliveryId?: number) {
  await sendMessage(chatId, `${ENV_LABEL[env] ?? env}${minutes ? ` · ${minutes} min` : ""}\n${items.map((i) => "• " + esc(label(i))).join("\n")}`);
  for (const it of items) {
    try { await sendItem(chatId, it, env, deliveryId); }
    catch (e: any) { console.error(e); await sendMessage(chatId, `⚠️ Couldn't build "${esc(label(it))}": ${esc(String(e.message ?? e)).slice(0, 200)}`); }
  }
}

export async function sendItem(chatId: number, it: PlanItem, env: string, deliveryId?: number) {
  switch (it.type) {
    case "unit": return sendUnit(chatId, it.unit_id, env, it.mode ?? "study");
    case "drill": {
      // reuse a recent unplayed drill for the same codes, else author a new one
      const existing = await one`SELECT id FROM drills WHERE competency_codes = ${it.competency_codes} AND times_played = 0 AND created_at > now() - interval '3 days' ORDER BY id DESC LIMIT 1`;
      const id = existing ? Number(existing.id) : await authorDrill({ method: it.method, competency_codes: it.competency_codes, minutes: it.minutes });
      return sendDrill(chatId, id, deliveryId);
    }
    case "grammar_brief": return sendGrammarBrief(chatId, it.competency_code, deliveryId);
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

export async function sendCheckin(chatId: number, date: string) {
  const m = await one`SELECT COALESCE(SUM(minutes),0)::int AS mins, COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS verified FROM activity_log WHERE log_date = ${date}`;
  const d = await sql`SELECT slot, status FROM deliveries WHERE plan_date = ${date} AND slot NOT IN ('morning_card','checkin')`;
  const completed = d.filter((x) => x.status === "completed").length, sent = d.filter((x) => ["sent", "completed"].includes(x.status)).length;
  await kvSet("awaiting", { kind: "checkin", date }, 180);
  await sendMessage(chatId,
    `🌙 <b>Check-in</b> — <b>${m?.verified ?? 0} min verified</b> (${m?.mins ?? 0} logged) · ${completed}/${sent} slots checked.\nUnverified time (a podcast you just listened to)? Reply e.g. <code>25 min innerfrench in the car</code> — it's logged as reported, not verified.\n<i>Tomorrow's plan lands at 06:30.</i>`,
    [[{ text: "😴 Done for today", callback_data: "checkin:done" }]]);
}

export function label(i: PlanItem): string {
  switch (i.type) {
    case "unit": return `${i.resource_id} unit #${i.unit_id}${i.mode && i.mode !== "study" ? ` (${i.mode})` : ""}`;
    case "drill": return `Drill (${i.method.replace("_", " ")}): ${i.competency_codes.map(competencyName).join(", ")}`;
    case "grammar_brief": return `Grammar: ${competencyName(i.competency_code)}`;
    case "listening_set": return "TCF listening set";
    case "reading_set": return "TCF reading set";
    case "writing": return `Writing ${i.task === "micro" ? "micro" : "TCF " + i.task.slice(4).toUpperCase()}`;
    case "speaking": return `Speaking ${i.task === "micro" ? "micro" : "TCF " + i.task.slice(4).toUpperCase()}`;
    case "interview": return `Interview (TCF ${i.task.slice(4).toUpperCase()})`;
    case "srs": return `${i.count} cards`;
    case "surprise_test": return "Surprise retention test";
  }
}
