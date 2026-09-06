// In-bot spaced repetition. Typed answers checked by the bot (default); self-rated only for long phrases.
import { sql, one, json, getLearner, kvGet, kvSet, kvDel, logActivity } from "./db.js";
import { schedule, DEFAULT_W, type CardState, type Params, type Rating } from "./fsrs.js";
import { check, verdictToRating } from "./answer.js";
import { recordEvidence } from "./grammar.js";
import { sendMessage, editMessage, esc, type Keyboard } from "./telegram.js";
import { validCode } from "./coach.js";
import { localDate } from "./time.js";
import { busy } from "./flow.js";

export type NewCard = { front: string; back: string; accept?: string[]; kind?: string; answer_mode?: "typed" | "self_rated" | "voice"; competency_code?: string | null; unit_id?: number | null; tags?: string[] };

export async function addCards(cards: NewCard[]): Promise<number> {
  let n = 0;
  for (const c of cards) {
    if (!c.front?.trim() || !c.back?.trim()) continue;
    const mode = c.answer_mode ?? (c.back.split(/\s+/).length > 6 ? "self_rated" : "typed");
    const r = await sql`INSERT INTO cards (front, back, accept, kind, answer_mode, competency_code, unit_id, tags)
      VALUES (${c.front.trim()}, ${c.back.trim()}, ${c.accept ?? []}, ${c.kind ?? "vocab"}, ${mode}, ${validCode(c.competency_code)}, ${c.unit_id ?? null}, ${c.tags ?? []})
      ON CONFLICT (front, back) DO NOTHING RETURNING id`;
    if (r.length) n++;
  }
  return n;
}

async function params(): Promise<Params> {
  const p = await one`SELECT weights, request_retention, maximum_interval FROM fsrs_params WHERE id = 1`;
  const learner = await getLearner();
  // cap intervals at the exam horizon so nothing is scheduled past the test
  const horizon = learner.exam_date ? Math.max(7, Math.floor((new Date(learner.exam_date).getTime() - Date.now()) / 86400000)) : 180;
  return { w: p ? p.weights.map(Number) : DEFAULT_W, requestRetention: p ? Number(p.request_retention) : 0.9, maximumInterval: Math.min(p ? p.maximum_interval : 180, horizon) };
}

/** Due reviews first, then new cards within today's budget. */
export async function pickQueue(limit = 15): Promise<number[]> {
  const learner = await getLearner();
  const newPerDay = learner.settings?.new_cards_per_day ?? 20;
  const nt = await one`SELECT COUNT(DISTINCT card_id)::int AS n FROM review_log WHERE (reviewed_at AT TIME ZONE ${learner.tz})::date = ${localDate(learner.tz)}::date AND state_before = 'new'`;
  const due = await sql`SELECT id FROM cards WHERE NOT suspended AND state <> 'new' AND due <= now() ORDER BY due LIMIT ${limit}`;
  const budget = Math.max(0, Math.min(newPerDay - (nt?.n ?? 0), limit - due.length));
  const fresh = budget > 0 ? await sql`SELECT id FROM cards WHERE NOT suspended AND state = 'new' ORDER BY id LIMIT ${budget}` : [];
  return [...due, ...fresh].map((r) => Number(r.id));
}

type Session = { chatId: number; queue: number[]; pos: number; again: number; started: number; env: string; shown_at?: number; awaiting_typed?: number };

export async function startSession(chatId: number, limit = 15, env = "micro", intro?: string): Promise<number> {
  const b = await busy();
  if (b === "check" || b === "interview") {
    await kvSet("srs_deferred", { chatId, count: limit }, 180);
    await sendMessage(chatId, "🃏 Cards are queued — they'll come right after your current test.");
    return 0;
  }
  if (b === "srs") {   // already running: just re-show the current card
    const cur = await kvGet<Session>("srs_session");
    if (cur) { await sendCard(chatId, cur); return cur.queue.length - cur.pos; }
  }
  const queue = await pickQueue(limit);
  if (!queue.length) { await sendMessage(chatId, "✅ Rien à réviser pour l'instant."); const { onItemDone } = await import("./deliver.js"); await onItemDone("srs"); return 0; }
  const s: Session = { chatId, queue, pos: 0, again: 0, started: Date.now(), env };
  await kvSet("srs_session", s, 120);
  if (intro) await sendMessage(chatId, intro);
  await sendCard(chatId, s);
  return queue.length;
}

async function sendCard(chatId: number, s: Session) {
  const c = await one`SELECT * FROM cards WHERE id = ${s.queue[s.pos]}`;
  if (!c) return next(chatId, s);
  s.shown_at = Date.now();
  const pos = `${s.pos + 1}/${s.queue.length}`;
  if (c.answer_mode === "typed") {
    s.awaiting_typed = c.id;
    await kvSet("srs_session", s, 120);
    await kvSet("awaiting", { kind: "srs_typed", card_id: c.id }, 120);
    await sendMessage(chatId, `🃏 <b>${pos}</b> · <i>${esc(c.kind)}</i>\n\n<b>${esc(c.front)}</b>\n\n<i>Type the French.</i>`, [[{ text: "🤷 Don't know", callback_data: `srs:dk:${c.id}` }]]);
  } else {
    s.awaiting_typed = undefined;
    await kvSet("srs_session", s, 120);
    await sendMessage(chatId, `🃏 <b>${pos}</b> · <i>${esc(c.kind)}</i>\n\n${esc(c.front)}`, [[{ text: "👁 Show", callback_data: `srs:show:${c.id}` }]]);
  }
}

/** Learner typed an answer for the current typed card. */
export async function handleTyped(chatId: number, text: string) {
  const s = await kvGet<Session>("srs_session");
  if (!s?.awaiting_typed) return false;
  const c = await one`SELECT * FROM cards WHERE id = ${s.awaiting_typed}`;
  if (!c) return false;
  const verdict = check(text, c.back, c.accept ?? []);
  const rating = verdictToRating(verdict, s.shown_at ? Date.now() - s.shown_at : undefined);
  const line = verdict === "exact" ? `✅ <b>${esc(c.back)}</b>` : verdict === "close" ? `🟡 Almost — <b>${esc(c.back)}</b>` : `❌ <b>${esc(c.back)}</b>\n<i>you wrote: ${esc(text)}</i>`;
  await sendMessage(chatId, line);
  await applyRating(c, rating, s, text);
  return true;
}

export async function handleCallback(chatId: number, messageId: number, data: string) {
  const [, action, idStr, r] = data.split(":");
  const c = await one`SELECT * FROM cards WHERE id = ${Number(idStr)}`;
  const s = await kvGet<Session>("srs_session");
  if (!c) return;
  if (action === "show") {
    const kb: Keyboard = [[
      { text: "🔴 Again", callback_data: `srs:rate:${c.id}:1` }, { text: "🟠 Hard", callback_data: `srs:rate:${c.id}:2` },
      { text: "🟢 Good", callback_data: `srs:rate:${c.id}:3` }, { text: "🔵 Easy", callback_data: `srs:rate:${c.id}:4` }]];
    await editMessage(chatId, messageId, `🃏 ${esc(c.front)}\n\n➡️ <b>${esc(c.back)}</b>`, kb);
    return;
  }
  if (action === "dk") {
    await editMessage(chatId, messageId, `🃏 ${esc(c.front)}\n\n➡️ <b>${esc(c.back)}</b>  <i>(again)</i>`);
    if (s) await applyRating(c, 1, s, null);
    return;
  }
  if (action === "rate" && s) {
    const rating = Number(r) as Rating;
    await editMessage(chatId, messageId, `🃏 ${esc(c.front)}\n\n➡️ <b>${esc(c.back)}</b>  <i>${["", "again", "hard", "good", "easy"][rating]}</i>`);
    await applyRating(c, rating, s, null);
  }
}

async function applyRating(c: any, rating: Rating, s: Session, typed: string | null) {
  const p = await params();
  const st: CardState = { state: c.state, stability: Number(c.stability), difficulty: Number(c.difficulty), reps: c.reps, lapses: c.lapses, last_review: c.last_review ? new Date(c.last_review) : null };
  const nx = schedule(st, rating, p);
  await sql`UPDATE cards SET state=${nx.state}::card_state, stability=${nx.stability}, difficulty=${nx.difficulty}, reps=${nx.reps}, lapses=${nx.lapses},
            last_review=now(), due=${nx.due.toISOString()}, elapsed_days=${nx.elapsed_days}, scheduled_days=${nx.scheduled_days} WHERE id=${c.id}`;
  await sql`INSERT INTO review_log (card_id, rating, state_before, elapsed_days, scheduled_days, stability_after, difficulty_after, typed_answer, latency_ms, environment)
            VALUES (${c.id}, ${rating}, ${c.state}::card_state, ${nx.elapsed_days}, ${nx.scheduled_days}, ${nx.stability}, ${nx.difficulty}, ${typed}, ${s.shown_at ? Date.now() - s.shown_at : null}, ${s.env}::environment)`;
  if (c.competency_code) await recordEvidence("card_review", c.id, [{ competency_code: c.competency_code, correct: rating >= 3, weight: 0.5, excerpt: typed ?? undefined }]);
  await kvDel("awaiting");
  if (rating === 1) { s.again++; s.queue.push(c.id); }
  s.pos++;
  await next(s.chatId, s);
}

/** End a running card session early (a check takes priority). Progress so far is already saved per card. */
export async function abortSession(chatId: number) {
  const s = await kvGet<Session>("srs_session");
  if (!s) return;
  await kvDel("srs_session"); await kvDel("awaiting");
  if (s.pos > 0) await logActivity(localDate((await getLearner()).tz), s.env, "srs", Math.max(1, Math.round((Date.now() - s.started) / 60000)), true);
  await sendMessage(chatId, `🃏 Cards paused after ${s.pos} (${s.queue.length - s.pos} left — /review any time).`);
}

async function next(chatId: number, s: Session) {
  if (s.pos < s.queue.length && s.pos < 45) { await sendCard(chatId, s); return; }
  await kvDel("srs_session");
  const mins = Math.max(1, Math.round((Date.now() - s.started) / 60000));
  await logActivity(localDate((await getLearner()).tz), s.env, "srs", mins, true);
  await sendMessage(chatId, `🎉 ${s.queue.length} cartes · ${s.again} à revoir · ${mins} min.`);
  const { onItemDone } = await import("./deliver.js");
  await onItemDone("srs");
}

export async function srsStats() {
  const load = await one`SELECT * FROM v_fsrs_load`;
  const ret = await one`SELECT COUNT(*)::int AS n, COALESCE(AVG(CASE WHEN rating >= 3 THEN 1 ELSE 0 END),0)::float AS ok FROM review_log WHERE reviewed_at >= now() - interval '14 days'`;
  const total = await one`SELECT COUNT(*)::int AS n FROM cards WHERE NOT suspended`;
  return { due_now: Number(load?.due_now ?? 0), due_tomorrow: Number(load?.due_tomorrow ?? 0), new_available: Number(load?.new_available ?? 0), relearning: Number(load?.relearning ?? 0), total: Number(total?.n ?? 0), retention_14d: Number(ret?.ok ?? 0), reviews_14d: Number(ret?.n ?? 0) };
}
