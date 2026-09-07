// "▶️ Keep going" — the door out of a finished slot.
//
// THE RULE: /more never advances the frontier. It deepens the position you are already in.
//
// Why: the ladder is paced at one lesson a day because the next day replays lesson n-1 for shadowing
// and recalls it EN→FR. Pulling lessons forward collapses that spacing, lets resource_units.status
// ='passed' outrun the cards that carry the same material (cards enter as 'new' and are gated by the
// daily budget, so nine lessons "passed" can sit on three lessons' worth of retention), and — since
// stage() promotes on volume — could hand you the core planner after one restless week.
//
// So steps 4-6 below are unlimited and introduce nothing new. Step 7 is capped at one new lesson per
// calendar day, and step 8 tells you to stop. This is the same priority shape lib/select.ts will take.
import { sql, one, getLearner, kvGet, kvSet } from "./db.js";
import { sendMessage } from "./telegram.js";
import { localDate } from "./time.js";
import { busy } from "./flow.js";

/** How many lessons were passed today, in the learner's own timezone. */
async function newLessonsToday(tz: string, date: string): Promise<number> {
  const r = await one`SELECT COUNT(*)::int AS n FROM resource_units
     WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')
       AND last_used IS NOT NULL AND (last_used AT TIME ZONE ${tz})::date = ${date}::date`;
  return Number(r?.n ?? 0);
}

export async function keepGoing(chatId: number) {
  if (await busy()) return sendMessage(chatId, "⏳ Finish what's open first, or /skip it.");
  const l = await getLearner();
  const date = localDate(l.tz);
  const target = Number(l.settings?.target_minutes ?? 150);

  // rotation so repeated taps don't hand you the same consolidation item twice
  const seen = await kvGet<{ date: string; n: number }>("more_count");
  const n = seen?.date === date ? seen.n + 1 : 0;
  await kvSet("more_count", { date, n }, 24 * 60);

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

  // ---- consolidation: unlimited, and none of it introduces new material ----
  const recent = await sql`SELECT id, seq FROM resource_units
     WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')
     ORDER BY seq DESC LIMIT 2`;

  // 4 — active recall of a lesson you've passed: English lines back into French
  if (recent.length && n % 3 === 0) {
    const u = recent[n % recent.length];
    const { sendUnit } = await import("./units.js");
    await sendMessage(chatId, `🔁 Active recall — leçon ${u.seq}, from English back into French. Nothing new, just harder.`);
    return sendUnit(chatId, Number(u.id), "seated", "active");
  }

  // 5 / 6 — produce something with what you already have
  const { sendWritingTask, sendSpeakingTask } = await import("./generate.js");
  if (n % 3 === 1) { await sendMessage(chatId, "✍️ A few sentences, built only from words you've met."); return sendWritingTask(chatId, "micro"); }
  if (n % 3 === 2) { await sendMessage(chatId, "🗣 Say this one out loud — hold the mic."); return sendSpeakingTask(chatId, "micro"); }

  // 7 — a new lesson, at most ONE per calendar day, and not past 150% of your target
  const passedToday = await newLessonsToday(l.tz, date);
  const mins = Number((await one`SELECT COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS m
                                 FROM activity_log WHERE log_date = ${date}`)?.m ?? 0);
  if (passedToday === 0 && mins < target * 1.5) {
    const { nextUnit, sendUnit } = await import("./units.js");
    const nxt = (await nextUnit("assimil")) ?? (await nextUnit("coach_lessons"));
    if (nxt) {
      await sendMessage(chatId, `⏭ Nothing left from today's plan — starting leçon ${nxt.seq}.`);
      return sendUnit(chatId, Number(nxt.id), "seated", "study");
    }
  }

  // 8 — the honest answer
  return sendMessage(chatId,
    passedToday > 0
      ? `🌙 You've already passed a lesson today (${mins} min in). A second one now would land on top of the first instead of on top of a night's sleep — that's how the spacing stops working.\n\n<i>More recall, writing or speaking is always available: tap again. The next lesson arrives tomorrow at 06:30.</i>`
      : `🌙 That's ${mins} min today, against a ${target} min target. Stopping here is the right move.\n\n<i>Tap again if you want more recall or production — nothing new until tomorrow.</i>`,
    [[{ text: "🔁 More recall / production", callback_data: "more:next" }]]);
}
