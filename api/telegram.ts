// Telegram webhook: commands, buttons, typed answers (cards / checks / writing), voice (checks / speaking / interview).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { waitUntil } from "@vercel/functions";
import { sql, one, getLearner, kvGet, kvSet, kvDel, logActivity } from "../lib/db.js";
import { sendMessage, answerCallback, editMessage, downloadFile, esc } from "../lib/telegram.js";
import * as srs from "../lib/srs.js";
import * as checks from "../lib/checks.js";
import { sendUnit, sendNotes, startUnitCheck, nextUnit } from "../lib/units.js";
import { sendDrill, startSpotCheck, authorDrill } from "../lib/drills.js";
import { sendListeningSet, sendReadingSet, sendWritingTask, sendSpeakingTask, startInterview, sendGrammarBrief, startGrammarTest } from "../lib/generate.js";
import { gradeWriting, gradeSpeaking, finishInterview } from "../lib/grade.js";
import { buildPlan, rebuildToday } from "../lib/planner.js";
import { sendMorningCard, sendSlot, sendQueued } from "../lib/deliver.js";
import { advance, clearAll, queueInfo } from "../lib/flow.js";
import { sendProgress } from "../lib/progress.js";
import { teachable } from "../lib/grammar.js";
import { tutor, ask, COMPETENCIES, pingModels, isQuotaExhausted, quotaPaused } from "../lib/coach.js";
import { localDate } from "../lib/time.js";
import { startFromZero, stage, INTRO } from "../lib/stage.js";
import { startPractice, practiceAnswer, explainLastMiss } from "../lib/teach.js";
import { challenge, liveAnswer, looksLikeQuestion } from "../lib/live.js";
import { sendReadiness } from "../lib/nclc.js";
import { rescueUnit, rescueDrill } from "../lib/rescue.js";
import { keepGoing } from "../lib/more.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(200).send("ok");
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) return res.status(401).send("bad secret");
  res.status(200).send("ok");
  waitUntil((async () => {
    // Telegram re-delivers updates it thinks were lost; process each update_id once.
    const uid = Number(req.body?.update_id);
    if (uid) {
      const seen = await sql`INSERT INTO kv (k, v, expires_at) VALUES (${"upd:" + uid}, '1'::jsonb, now() + interval '1 day') ON CONFLICT (k) DO NOTHING RETURNING k`;
      if (!seen.length) return;
    }
    await route(req.body);
  })().catch(async (e: any) => {
    console.error(e);
    const l = await getLearner().catch(() => null);
    const msg = String(e?.message ?? e);
    const friendly = isQuotaExhausted(e)
      ? "⏸ Gemini's free-tier daily quota for this key is used up. Deliveries are paused until it resets at 03:00 Toronto (midnight Pacific) — nothing to do on your side. Enabling billing on the key removes the cap for good."
      : /503|high demand|UNAVAILABLE/i.test(msg) ? "⚠️ Gemini is overloaded on every model in the chain right now — try again in a minute."
      : `⚠️ ${esc(msg).slice(0, 300)}`;
    if (l?.chat_id) await sendMessage(l.chat_id, friendly).catch(() => {});
  }));
}

async function route(u: any) {
  if (u.callback_query) return onCallback(u.callback_query);
  if (u.message) return onMessage(u.message);
}

async function allowed(chatId: number) {
  const want = Number(process.env.TELEGRAM_CHAT_ID);
  if (want && chatId !== want) { await sendMessage(chatId, "Private coach bot."); return false; }
  const l = await getLearner();
  if (!l.chat_id) await sql`UPDATE learner SET chat_id = ${chatId} WHERE id = 1`;
  return true;
}

async function onMessage(m: any) {
  const chatId = m.chat.id as number;
  if (!(await allowed(chatId))) return;
  const text: string = (m.text ?? "").trim();

  if (m.voice || m.audio) {
    const f = m.voice ?? m.audio;
    const bytes = await downloadFile(f.file_id);
    const mime = f.mime_type ?? "audio/ogg";
    if (await checks.answer({ audio: { data: bytes, mime } })) return;          // voice item in a check
    if (await liveAnswer({ audio: { data: bytes, mime } })) return;            // spoken answer to "say it in French"
    return gradeSpeaking(chatId, bytes, mime, f.file_id, f.duration);         // interview turn, speaking task, or free speaking
  }
  if (!text) return;
  if (text.startsWith("/")) return onCommand(chatId, text);

  // 1. an open check consumes typed answers; 2. guided practice; 3. an open card session
  if (await checks.answer({ text })) return;
  if (await practiceAnswer(text)) return;
  if (await srs.handleTyped(chatId, text)) return;
  if (await liveAnswer({ text })) return;                                     // typed answer to "say it in French"

  const awaiting = await kvGet<any>("awaiting");
  if (await kvGet("interview_session")) { await sendMessage(chatId, "🎙 The interview is by voice — hold the mic and answer, or tap ⏹ End interview."); return; }
  if (awaiting?.kind === "writing") return gradeWriting(chatId, text);
  if (awaiting?.kind === "checkin" && !looksFrench(text) && /\b\d{1,3}\s*(min|minutes|h|hours?)\b/i.test(text)) return parseAndLog(chatId, text);
  if (looksFrench(text)) return gradeWriting(chatId, text);
  // English: a question is for the tutor; a thought about your own life is something to say in French
  if (!looksLikeQuestion(text) && text.split(/\s+/).length >= 3) return void (await challenge(chatId, text));
  await sendMessage(chatId, esc(await tutor(text)));
}

async function onCommand(chatId: number, text: string) {
  const [cmd, ...args] = text.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@.*$/, "");
  const paused = await quotaPaused();
  if (paused && paused > new Date() && !["/help", "/start", "/progress", "/skip", "/next", "/exam", "/nclc", "/readiness", "/roadmap", "/codes", "/ping"].includes(c))
    return sendMessage(chatId, `⏸ Paused until ${paused.toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit" })} Toronto — Gemini's free daily quota is used up. /ping to test it early.`);
  const l = await getLearner();
  const today = localDate(l.tz);
  switch (c) {
    case "/start": {
      const passed = await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE status IN ('passed','mastered')`;
      if (l.placement_done && Number(passed?.n ?? 0) > 0) return sendMessage(chatId, `👋 Salut ! /today shows the plan; everything else arrives on its own.`);
      if (l.placement_done) return sendMessage(chatId, `👋 Salut ! Level is set. Start from zero anyway (fixed beginner lessons, no test)?`, [[{ text: "🌱 Yes — from zero", callback_data: "zero:yes" }], [{ text: "📋 No, show today", callback_data: "slot:today" }]]);
      return sendMessage(chatId, `👋 Salut ! I'm your TCF Canada coach.\n\nWhere are you starting from?`, [
        [{ text: "🌱 From zero — no test, start lesson 1", callback_data: "zero:yes" }],
        [{ text: "🧪 I know some French — placement test (10 min)", callback_data: "zero:placement" }]]);
    }
    case "/zero": { await startFromZero(); await sendMessage(chatId, INTRO); const { date, plan } = await rebuildToday(); return sendMorningCard(chatId, date, plan); }
    case "/how": return sendMessage(chatId, INTRO);
    case "/more": case "/next2": return keepGoing(chatId);
    case "/roadmap": {
      const { CURRICULUM } = await import("../lib/units.js");
      const { roadmapLine } = await import("../lib/deliver.js");
      const passed = Number((await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('passed','mastered')`)?.n ?? 0);
      const rows = CURRICULUM.units.map((u) => `${u.n <= passed ? "✅" : u.n === passed + 1 ? "▶️" : "▫️"} ${u.n}. ${esc(u.title)} <i>— ${esc(u.can_do)}</i>`);
      const stages = CURRICULUM.stages.map((st) => `<b>Stage ${st.id} — ${esc(st.name)}</b> (units ${st.units}, CLB ${st.clb})`).join("\n");
      const { splitTelegram } = await import("../lib/text.js");
      for (const c of splitTelegram(`🗺 <b>Roadmap — zero → CLB 4 in 40 lessons, then the exam planner</b>\n${stages}\n\n${rows.join("\n")}`)) await sendMessage(chatId, c);
      return;
    }
    case "/help":
      return sendMessage(chatId, "/today /roadmap /progress /nclc /how /ping\n/review [n] · /lesson [n] · /drill CODE [method] · /grammar CODE\n/listen /read /write [w1|w2|w3] /speak [s1|s2|s3] /interview [s1|s3]\n/fr [an English thought] = say it in French · /codes · /exam YYYY-MM-DD · /log 25 min podcast · /skip · /next · /more\nAny voice note = speaking feedback; any French text = writing feedback; an English question = tutor; an English statement about your day = I make you say it in French.");
    case "/placement": {
      await sendMessage(chatId, "Building your placement test…");
      const items = await checks.authorPlacement();
      return checks.startCheck({ chatId, type: "placement", title: "Placement", items, env: "seated", pass_pct: 0 });
    }
    case "/today": {
      const p = await one`SELECT plan, inputs_digest FROM plans WHERE plan_date = ${today}`;
      const st = await stage();
      if (p && (st !== "beginner" || p.inputs_digest?.stage === "beginner")) return sendMorningCard(chatId, today, p.plan);   // stale pre-beginner-track plan → rebuild
      await sendMessage(chatId, "No plan yet — building one (≈30 s)…");
      const { plan } = await buildPlan(today);
      return sendMorningCard(chatId, today, plan);
    }
    case "/replan": { await sendMessage(chatId, "Re-planning today from scratch…"); const { plan } = await rebuildToday(); return sendMorningCard(chatId, today, plan); }
    case "/review": return srs.startSession(chatId, Number(args[0]) || 15, "micro");
    case "/lesson": {
      const n = Number(args[0]);
      const u = n ? await one`SELECT id FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND seq = ${n} ORDER BY (resource_id = 'assimil') DESC LIMIT 1`
                  : (await nextUnit("assimil")) ?? (await nextUnit("coach_lessons"));
      if (!u) return sendMessage(chatId, "No lesson available yet.");
      return sendUnit(chatId, Number(u.id), "patrol", "study");
    }
    case "/drill": {
      const code = args[0]?.toUpperCase();
      const codes = code && COMPETENCIES.some((x) => x.code === code) ? [code] : (await teachable(1)).map((t: any) => t.code);
      if (!codes.length) return sendMessage(chatId, "No teachable competency found.");
      const method = (["pimsleur", "michel_thomas", "language_transfer"].includes(args[1]) ? args[1] : "pimsleur") as any;
      await sendMessage(chatId, `Authoring a ${method.replace("_", " ")} drill on ${codes.join(", ")} (≈1-2 min: script + audio)…`);
      return sendDrill(chatId, await authorDrill({ method, competency_codes: codes }));
    }
    case "/grammar": {
      const code = args[0]?.toUpperCase();
      const codes = code && COMPETENCIES.some((x) => x.code === code) ? code : (await teachable(1))[0]?.code;
      return codes ? sendGrammarBrief(chatId, codes) : sendMessage(chatId, "Nothing teachable yet.");
    }
    case "/ping": {
      await sendMessage(chatId, "Pinging models…");
      const r = await pingModels();
      if (r.some((x) => x.startsWith("✅"))) await kvDel("quota_paused_until");
      return sendMessage(chatId, esc(r.join("\n")));
    }
    case "/codes": return sendMessage(chatId, COMPETENCIES.map((x) => `<code>${x.code}</code> ${esc(x.name)}`).join("\n"));
    case "/listen": return sendListeningSet(chatId, "patrol");
    case "/read": return sendReadingSet(chatId, "seated");
    case "/write": return sendWritingTask(chatId, ({ w1: "tcf_w1", w2: "tcf_w2", w3: "tcf_w3" } as any)[args[0]] ?? "micro");
    case "/speak": return sendSpeakingTask(chatId, ({ s1: "tcf_s1", s2: "tcf_s2", s3: "tcf_s3" } as any)[args[0]] ?? "micro");
    case "/interview": return startInterview(chatId, args[0] === "s3" ? "tcf_s3" : "tcf_s1");
    case "/progress": return sendProgress(chatId);
    case "/log": return parseAndLog(chatId, args.join(" "));
    case "/skip": {
      const q = await queueInfo();
      await clearAll();
      await sendMessage(chatId, "Cleared the current item/test.");
      if (q?.items?.length) { await kvSet("slot_queue", { ...q, current: undefined }, 8 * 60); return advance(sendQueued); }
      return;
    }
    case "/next": return (await advance(sendQueued)) ? undefined : sendMessage(chatId, "Nothing queued.");
    case "/fr": {
      if (args.length) return void (await challenge(chatId, args.join(" ")));
      const t = await ask<{ en: string }>("EXAMINER",
        `One everyday English sentence a security guard in Toronto would actually think or say today (≤12 words, present or near future, concrete). Return {"en"}`, { temperature: 0.9 });
      return void (await challenge(chatId, String(t.en ?? "I start work at eight tonight.")));
    }
    case "/nclc":
    case "/readiness": return sendReadiness(chatId);
    case "/exam": {
      if (!args[0]) { await sendReadiness(chatId); return sendMessage(chatId, `Set your exam date with /exam 2027-05-15${l.exam_date ? ` (currently ${l.exam_date})` : ""}.`); }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(args[0])) return sendMessage(chatId, "Use YYYY-MM-DD, e.g. /exam 2027-05-15");
      await sql`UPDATE learner SET exam_date = ${args[0]}::date WHERE id = 1`;
      return sendMessage(chatId, `Exam date set: ${args[0]}. FSRS intervals are now capped at that horizon.`);
    }
    default: return sendMessage(chatId, "Unknown command — /help");
  }
}

async function onCallback(q: any) {
  const chatId = q.message.chat.id as number, mid = q.message.message_id as number;
  const data: string = q.data ?? "";
  await answerCallback(q.id);
  const l = await getLearner();
  const [kind, a, b, c] = data.split(":");

  if (kind === "srs") return srs.handleCallback(chatId, mid, data);
  if (kind === "zero") {
    if (a === "yes") { await startFromZero(); await editMessage(chatId, mid, "🌱 Beginner track set. Building day one…"); await sendMessage(chatId, INTRO); const { date, plan } = await rebuildToday(); return sendMorningCard(chatId, date, plan); }
    await editMessage(chatId, mid, "🧪 Placement — building it…");
    return checks.startCheck({ chatId, type: "placement", title: "Placement", items: await checks.authorPlacement(), env: "seated", pass_pct: 0 });
  }
  if (kind === "q" && a === "next") { if (!(await advance(sendQueued))) await keepGoing(chatId); return; }
  if (kind === "more" && a === "next") return keepGoing(chatId);
  if (kind === "huh") return a === "drill" ? rescueDrill(chatId, Number(b)) : rescueUnit(chatId, Number(b), c || "patrol");
  if (kind === "chk") {
    if (a === "mcq") return checks.answer({ pos: Number(b), mcq: Number(c), messageId: mid });
    if (a === "skip") return checks.answer({ pos: b !== undefined ? Number(b) : undefined, skip: true });
    if (a === "slow") return checks.replaySlow();
  }
  if (kind === "unit") {
    if (a === "check") { const [, , , dId, env] = data.split(":"); return startUnitCheck(chatId, Number(b), env && env !== "undefined" ? env : "patrol", Number(dId) || undefined); }
    if (a === "practice") { const saved = await kvGet<{ cb: string }>("practice_cb:" + b); return startPractice(chatId, Number(b), saved?.cb ?? `unit:check:${b}:0:patrol`); }
    if (a === "notes") return sendNotes(chatId, Number(b));
    if (a === "teach") {
      const u = await one`SELECT * FROM resource_units WHERE id = ${Number(b)}`;
      if (!u) return;
      const { teach } = await import("../lib/teach.js");
      return teach(chatId, u, "seated");
    }
  }
  if (kind === "prac" && a === "show") return practiceAnswer(undefined, true);
  if (kind === "start2") {
    const u = await one`SELECT * FROM resource_units WHERE id = ${Number(a)}`;
    if (!u) return;
    const { teachIntro } = await import("../lib/teach.js");
    await teachIntro(chatId, u);
    return sendMessage(chatId, "That's the start. When you're walking:", [[{ text: "▶️ Continue the lesson", callback_data: "slot:patrol" }]]);
  }
  if (kind === "why") return explainLastMiss(chatId);
  if (kind === "live" && a === "give") return void (await liveAnswer({ give: true }));
  if (kind === "drill" && a === "spot") return startSpotCheck(chatId, Number(b), c ? Number(c) : undefined);
  if (kind === "gram" && a === "test") return startGrammarTest(chatId, b, c ? Number(c) : undefined);
  if (kind === "interview" && a === "end") return finishInterview(chatId);
  if (kind === "skip") {   // skip:writing | skip:speaking — abandon that task only, move the slot on
    const aw = await kvGet<any>("awaiting");
    if (aw?.kind === a) await kvDel("awaiting");
    if (aw?.submission_id) await sql`DELETE FROM submissions WHERE id = ${aw.submission_id} AND graded_at IS NULL`;
    await editMessage(chatId, mid, `⏭ ${esc(a)} skipped — the planner sees this.`);
    await logActivity(localDate(l.tz), "seated", `skipped_${a}`, 0, true);
    const q = await queueInfo();
    if (q?.current?.type === a) await advance(sendQueued);
    return;
  }
  if (kind === "checkin" && a === "done") { await kvDel("awaiting"); return editMessage(chatId, mid, "🌙 Bonne nuit."); }
  if (kind === "slot" && a === "today") return onCommand(chatId, "/today");
  if (kind === "slot") {
    const date = localDate(l.tz);
    if (a === "srs") return srs.startSession(chatId, 15, "micro");
    const p = await one`SELECT plan FROM plans WHERE plan_date = ${date}`;
    const slot = p?.plan?.slots?.find((s: any) => s.environment === a);
    if (!slot) return sendMessage(chatId, "That slot isn't in today's plan.", [[{ text: "▶️ Keep going", callback_data: "more:next" }]]);
    const sentAlready = await one`SELECT id, status FROM deliveries WHERE plan_date=${date} AND environment=${a}::environment AND status IN ('sent','sending','completed') ORDER BY scheduled_at DESC LIMIT 1`;
    if (sentAlready) return sendMessage(chatId, sentAlready.status === "completed" ? "That slot is already done today." : "That slot was already sent — scroll up, or carry on below.",
      [[{ text: "⏭ Next item", callback_data: "q:next" }], [{ text: "▶️ Keep going", callback_data: "more:next" }]]);
    const d = await one`SELECT id FROM deliveries WHERE plan_date=${date} AND environment=${a}::environment AND status='pending' ORDER BY scheduled_at LIMIT 1`;
    if (d) await sql`UPDATE deliveries SET status='sent', sent_at=now() WHERE id=${d.id}`;
    return sendSlot(chatId, a, slot.items, slot.minutes, d ? Number(d.id) : undefined);
  }
}

async function parseAndLog(chatId: number, text: string) {
  const l = await getLearner();
  const p = await ask<{ entries: { minutes: number; environment: string; activity: string }[] }>("TUTOR",
    `Parse study time from: "${text}". environment ∈ patrol|driving|seated|micro. Return {"entries":[{"minutes","environment","activity"}]} (empty if none).`, { temperature: 0 });
  if (!p.entries?.length) return sendMessage(chatId, "No minutes found. Try: /log 25 min podcast driving");
  for (const e of p.entries) await logActivity(localDate(l.tz), ["patrol", "driving", "seated", "micro"].includes(e.environment) ? e.environment : "seated", e.activity, e.minutes, false);
  await kvDel("awaiting");
  return sendMessage(chatId, `Logged (reported): ${p.entries.map((e) => `${Number(e.minutes) || 0} min ${esc(e.activity)} (${esc(e.environment)})`).join(", ")}.`);
}

const looksFrench = (t: string) => /[àâçéèêëîïôûùüÿœ]/i.test(t) || /\b(je|tu|il|elle|nous|vous|ils|est|suis|les|des|une|pas|avec|pour|dans|que|qui|bonjour|merci)\b/i.test(t);
