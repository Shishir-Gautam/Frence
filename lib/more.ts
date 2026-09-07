// "▶️ Keep going" — the door out of a finished slot.
//
// A deliberately small, hand-written preview of lib/select.ts (ARCHITECTURE §4): the same priority
// order, minus the module layer that doesn't exist yet. Its job is that finishing a slot is never
// a dead end — there is always a next thing, and you never have to decide what it is.
import { sql, one, getLearner } from "./db.js";
import { sendMessage } from "./telegram.js";
import { localDate } from "./time.js";
import { busy } from "./flow.js";

export async function keepGoing(chatId: number) {
  if (await busy()) return sendMessage(chatId, "⏳ Finish what's open first, or /skip it.");
  const l = await getLearner();
  const date = localDate(l.tz);

  // 1 — another slot from today's plan that hasn't gone out yet
  const pending = await one`SELECT id, environment::text AS env FROM deliveries
     WHERE plan_date = ${date} AND status = 'pending' AND slot NOT IN ('morning_card','checkin')
     ORDER BY scheduled_at LIMIT 1`;
  if (pending) {
    const p = await one`SELECT plan FROM plans WHERE plan_date = ${date}`;
    const slot = (p?.plan?.slots ?? []).find((s: any) => s.environment === pending.env);
    if (slot?.items?.length) {
      await sql`UPDATE deliveries SET status = 'sent', sent_at = now() WHERE id = ${pending.id}`;
      const { sendSlot } = await import("./deliver.js");
      return sendSlot(chatId, pending.env, slot.items, slot.minutes, Number(pending.id));
    }
  }

  // 2 — anything due for review (never let a backlog build while you're asking for more work)
  const due = await one`SELECT due_now FROM v_fsrs_load`;
  if (Number(due?.due_now ?? 0) > 0) {
    const { startSession } = await import("./srs.js");
    return startSession(chatId, Math.min(20, Number(due!.due_now)), "micro", "🃏 These are due — type the French.");
  }

  // 3 — the lesson you're on isn't passed yet
  const open = await one`SELECT id, seq FROM resource_units
     WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('scheduled','attempted')
     ORDER BY (status = 'attempted') DESC, seq LIMIT 1`;
  if (open) {
    const { sendUnit } = await import("./units.js");
    await sendMessage(chatId, `📖 Leçon ${open.seq} isn't passed yet — let's finish it.`);
    return sendUnit(chatId, Number(open.id), "seated", "study");
  }

  // 4 — pull the next lesson forward rather than telling you to come back tomorrow
  const { nextUnit, sendUnit } = await import("./units.js");
  const nxt = (await nextUnit("assimil")) ?? (await nextUnit("coach_lessons"));
  if (nxt) {
    await sendMessage(chatId, `⏭ Nothing left for today — pulling leçon ${nxt.seq} forward.`);
    return sendUnit(chatId, Number(nxt.id), "seated", "study");
  }

  // 5 — last resort: produce something
  const { sendWritingTask } = await import("./generate.js");
  await sendMessage(chatId, "You're ahead of the plan. One short piece of writing, then:");
  return sendWritingTask(chatId, "micro");
}
