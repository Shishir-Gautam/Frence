// EXECUTING an exam task module. lib/task-modules.ts decided WHICH module and WHICH activity; nothing here may change that.
//
// The prompt Gemini receives is deliberately small and closed: the module's objective, its known failure modes,
// this learner's recurring flags inside it, the activity to run, and the time available. It is asked "execute this",
// never "decide what would be good today". Everything it produces is scored by the existing check/grade engines,
// and the score is what moves the module's state.
import { sql, one, kvSet, kvGet, kvDel, currentClb } from "./db.js";
import { sendMessage, sendVoice, esc } from "./telegram.js";
import { ask, askGrounded, randomTheme, clbToCefr } from "./coach.js";
import { speakFrench } from "./tts.js";
import { startCheck, sanitize, type Item, type CheckType } from "./checks.js";
import { taskDef, taskBrief, nextActivity, pickTaskModule, recordTaskEvidence, type Activity } from "./task-modules.js";
import { splitTelegram } from "./text.js";

/** kv `module_run` links a submission or check back to the module that ordered it. */
export type ModuleRun = { module_id: string; activity: Activity; submission_id?: number; delivery_id?: number; started: number };

export async function runModule(chatId: number, moduleId: string, activity?: Activity, deliveryId?: number) {
  const row = await one`SELECT * FROM v_task_module_board WHERE id = ${moduleId}`;
  if (!row) return sendMessage(chatId, `Unknown module ${esc(moduleId)}.`);
  const def = taskDef(moduleId)!;
  const act = activity ?? nextActivity(row);
  const brief = taskBrief(row, act);
  const clb = (await currentClb())[def.component].clb;
  const header = `🧩 <b>${def.id} — ${esc(def.name)}</b>  <i>${act.replace("_", " ")}</i>\n🎯 ${esc(def.can_do)}`;

  if (def.component === "listening" || def.component === "reading") return runReceptive(chatId, row, act, brief, clb, header, deliveryId);
  return runProductive(chatId, row, act, brief, clb, header, deliveryId);
}

/** Listening/reading: a set built to this module's objective, scored by the check engine. */
async function runReceptive(chatId: number, row: any, act: Activity, brief: string, clb: number, header: string, deliveryId?: number) {
  const def = taskDef(String(row.id))!;
  const timed = act === "timed_set";
  const n = timed ? 8 : 5;
  const set = await ask<{ title: string; passage?: string; text?: string; items: Item[] }>("EXAMINER",
    `${brief}

Build ONE ${def.component} set that trains exactly this module's objective and nothing else. Learner ${def.component} CLB ${clb.toFixed(1)} — pitch the material at CLB ${Math.min(12, Math.ceil(clb + 1))} (${clbToCefr(clb + 1)}). Theme: ${randomTheme()}.
${def.component === "listening"
  ? `passage: natural spoken French, 70-150 words, containing exactly what this module is about.`
  : `text: authentic-looking written French of the type this module names, 90-200 words.`}
items: ${n} MCQs, kind "mcq", 4 options ≤60 chars, answer_index, item_clb, skill "${def.component}". At least ${Math.ceil(n / 2)} items must be unanswerable without the specific ability this module trains — and the wrong options must exploit its known failure modes.
${timed ? "This is the timed set: mimic exam pressure, no re-listening, mixed difficulty." : ""}
Return {"title","${def.component === "listening" ? "passage" : "text"}","items":[...]}`, { temperature: 0.5 });

  const body = String(set.passage ?? set.text ?? "");
  if (!body) throw new Error(`module ${row.id}: empty set`);
  await sendMessage(chatId, `${header}\n\n<i>${timed ? "Timed set — answer straight through, like the exam." : "One pass, then the questions."}</i>`);
  if (def.component === "listening") {
    await sendVoice(chatId, await speakFrench(body, "normal"), `🎧 ${esc(set.title ?? "")}${timed ? " — une seule écoute" : ""}`);
  } else {
    for (const c of splitTelegram(`📄 <b>${esc(set.title ?? "")}</b>\n\n${esc(body)}`)) await sendMessage(chatId, c);
  }
  await kvSet("module_run", { module_id: String(row.id), activity: act, delivery_id: deliveryId, started: Date.now() } satisfies ModuleRun, 180);
  const type: CheckType = def.component === "listening" ? "listening_set" : "reading_set";
  await startCheck({ chatId, type, title: `${def.id} ${def.name}`, items: sanitize(set.items), env: def.environments[0], pass_pct: 75,
    meta: { module_id: String(row.id), activity: act, delivery_id: deliveryId } });
}

/** Writing/speaking: model -> controlled -> spontaneous -> timed, each scored, each moving the state. */
async function runProductive(chatId: number, row: any, act: Activity, brief: string, clb: number, header: string, deliveryId?: number) {
  const def = taskDef(String(row.id))!;
  const speaking = def.component === "speaking";

  if (act === "model") {
    const m = await ask<{ model_fr: string; en: string; skeleton: string[]; phrases: { fr: string; en: string }[]; watch_out: string }>("EXAMINER",
      `${brief}

Teach this module before testing it. Return:
- model_fr: ONE model performance of this module's objective at CLB ${Math.max(4, Math.round(clb + 1))}, ${speaking ? "60-90 spoken words" : "70-110 written words"}, on the theme "${randomTheme()}".
- en: its English translation.
- skeleton: 3-5 steps naming the structure of that model ("position", "reason + example", "concession", "conclusion").
- phrases: 6-8 reusable expressions with EN gloss that this module lives on.
- watch_out: ≤25 words, the single failure mode this learner most needs to avoid here.
Return {"model_fr","en","skeleton","phrases","watch_out"}`, { temperature: 0.5 });
    const phr = (m.phrases ?? []).map((p) => `• <b>${esc(p.fr)}</b> — ${esc(p.en)}`).join("\n");
    for (const c of splitTelegram(`${header}\n\n<b>Modèle</b>\n${esc(m.model_fr)}\n\n<i>${esc(m.en)}</i>\n\n🧱 <b>Structure</b>\n${(m.skeleton ?? []).map((s, i) => `${i + 1}. ${esc(s)}`).join("\n")}\n\n🗝 <b>Phrases</b>\n${phr}\n\n⚠️ ${esc(m.watch_out ?? "")}`)) await sendMessage(chatId, c);
    if (speaking) await sendVoice(chatId, await speakFrench(m.model_fr, "normal"), "🐇 le modèle — shadow it twice");
    await recordTaskEvidence(String(row.id), { activity: "model", passed: true });
    return sendMessage(chatId, "Ready to try it under control?", [[{ text: "▶️ Controlled practice", callback_data: `mod:run:${row.id}:controlled` }]]);
  }

  if (act === "controlled") {
    const set = await ask<{ items: Item[] }>("EXAMINER",
      `${brief}

Write 5 CONTROLLED items: the learner supplies the module's structure with the content given to them, so only this capability is being tested. Each: kind "typed", prompt in ENGLISH stating exactly what to produce in French, expected = a correct French answer, accept = 2-4 acceptable variants, competency_code from the module's grammar where one applies, item_clb ${Math.max(3, Math.round(clb))}.
Items 4 and 5 must combine two elements of the module. Return {"items":[...]}`, { temperature: 0.4 });
    await kvSet("module_run", { module_id: String(row.id), activity: act, delivery_id: deliveryId, started: Date.now() } satisfies ModuleRun, 180);
    return startCheck({ chatId, type: "grammar_test", title: `${def.id} — controlled`, items: sanitize(set.items), env: "seated", pass_pct: def.evidence.controlled_pct ?? 80,
      meta: { module_id: String(row.id), activity: act, delivery_id: deliveryId } });
  }

  // spontaneous / timed -> a real graded submission
  const isTimed = act === "timed";
  const task = isTimed && def.tcf_task ? def.tcf_task : def.tcf_task ?? "micro";
  const p = await ask<{ prompt_fr: string; instructions_en: string; helpers: { fr: string; en: string }[] }>("EXAMINER",
    `${brief}

Write ONE ${isTimed ? "TIMED, exam-format" : "unprepared"} task that forces this module's objective and cannot be answered without it. Learner ${def.component} CLB ${clb.toFixed(1)}. Theme: ${randomTheme()}.
${def.tcf_task ? `Format: TCF Canada ${def.tcf_task.toUpperCase()}.` : ""}
${isTimed ? `Include the exam clock in instructions_en (${speaking ? "prep time and speaking time" : "minutes and word count"}).` : "No preparation: the learner answers immediately."}
helpers: at most 3 expressions — this is production, not a fill-in. Return {"prompt_fr","instructions_en","helpers":[{"fr","en"}]}`, { temperature: 0.6 });

  const ins = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES (${def.component}::skill, ${task}, 'seated', ${String(p.prompt_fr)}) RETURNING id`;
  const submissionId = Number(ins[0].id);
  await kvSet("module_run", { module_id: String(row.id), activity: act, submission_id: submissionId, delivery_id: deliveryId, started: Date.now() } satisfies ModuleRun, 12 * 60);
  await kvSet("awaiting", { kind: def.component, submission_id: submissionId, task, delivery_id: deliveryId }, 12 * 60);
  await sendMessage(chatId,
    `${header}\n\n${esc(p.prompt_fr)}\n\n<i>${esc(p.instructions_en ?? "")}</i>` +
    ((p.helpers ?? []).length ? `\n\n💡 ${(p.helpers ?? []).map((h) => `${esc(h.fr)} — ${esc(h.en)}`).join(" · ")}` : "") +
    `\n\n${speaking ? "🎙 Answer with a voice message." : "✍️ Reply with your text."}${isTimed ? " Keep to the clock — that is what is being tested." : ""}`,
    [[{ text: "⏭ Skip", callback_data: `skip:${def.component}` }]]);
}

/** Called by checks.finish / grade.finish: attribute a score to the module that ordered the work. */
export async function attributeToModule(score_pct: number | null, clb: number | null, opts: { submission_id?: number; module_id?: string; activity?: Activity; fail_signals?: string[]; ref?: { table: string; id: number } }) {
  let moduleId = opts.module_id, activity = opts.activity;
  if (!moduleId) {
    const run = await kvGet<ModuleRun>("module_run");
    if (!run) return null;
    if (opts.submission_id && run.submission_id && run.submission_id !== opts.submission_id) return null;
    moduleId = run.module_id; activity = run.activity;
    await kvDel("module_run");
  }
  const def = taskDef(moduleId!);
  if (!def || !activity) return null;
  const known = new Set(def.fail_signals);
  const flags = (opts.fail_signals ?? []).filter((f) => known.has(f));
  return recordTaskEvidence(moduleId!, { activity, score_pct: score_pct ?? undefined, clb: clb ?? undefined, fail_signals: flags, ref: opts.ref });
}

/** Authentic French media at the learner's level — a real, currently-online video, found by search, not invented. */
export async function sendWatch(chatId: number, deliveryId?: number) {
  const clb = await currentClb();
  const level = Math.max(1, Math.min(12, Math.round(clb.listening.clb)));
  const r = await askGrounded<{ title: string; url: string; channel: string; why: string; minutes: number; watch_for: string[]; vocab: { fr: string; en: string }[] }>("TUTOR",
    `Find ONE French-language video or podcast episode that is online right now and suits a learner at CLB ${level} (${clbToCefr(level)}) working towards TCF Canada. Search for it — do not recall one from memory, and do not invent a URL.
Prefer: slow/clear French for learners (InnerFrench, Français Authentique, Piece of French, Easy French), or short French news (RFI Journal en français facile, TV5Monde, HugoDécrypte, Brut, Arte). 5-20 minutes. Something a security guard in Toronto would find interesting, not a grammar lecture.
Return {"title","url" (the exact watch/episode URL you found),"channel","why" (≤20 words, English),"minutes","watch_for":[3 things to listen for],"vocab":[5 {"fr","en"} words likely to appear]}`,
    { temperature: 0.7 });
  const url = String(r.url ?? "");
  if (!/^https?:\/\//.test(url)) return sendMessage(chatId, "Couldn't find a video I can verify right now — skipping this one.");
  await kvSet("watch_last", { url, title: r.title, at: Date.now() }, 24 * 60);
  await sendMessage(chatId,
    `📺 <b>Regarde</b> — ${esc(String(r.title ?? ""))}\n${esc(String(r.channel ?? ""))} · ~${Number(r.minutes) || 10} min\n<i>${esc(String(r.why ?? ""))}</i>\n\n` +
    `👂 <b>Listen for</b>\n${(r.watch_for ?? []).map((w) => `• ${esc(String(w))}`).join("\n")}\n\n` +
    `🔤 ${(r.vocab ?? []).map((v) => `<b>${esc(v.fr)}</b> ${esc(v.en)}`).join(" · ")}\n\n${url}\n\n` +
    `<i>Watch with French subtitles if you need them. No test on this one — input is the point.</i>`,
    [[{ text: "✅ Watched", callback_data: "watch:done" }, { text: "🔁 Another", callback_data: "watch:more" }]]);
}
