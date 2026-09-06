// TCF task generator: listening/reading sets (checked by the engine), writing & speaking prompts, interview,
// grammar brief + test.
import { sql, one, json, getLearner, currentClb, kvSet } from "./db.js";
import { sendMessage, sendVoice, sendChatAction, esc, type Keyboard } from "./telegram.js";
import { ask, randomTheme, clbToCefr, COMPETENCIES } from "./coach.js";
import { speakFrench } from "./tts.js";
import { startCheck, authorGrammarTest, sanitize, type Item } from "./checks.js";
import { markTaught } from "./grammar.js";

/** Listening set: passage as voice note (heard once), then MCQ items via the check engine. */
export async function sendListeningSet(chatId: number, env = "patrol", deliveryId?: number) {
  const clb = (await currentClb()).listening.clb;
  const theme = randomTheme();
  const set = await ask<{ title: string; passage: string; items: Item[] }>("EXAMINER",
    `TCF Canada LISTENING set. Learner CLB ${clb.toFixed(1)}; pitch the audio at CLB ${Math.min(12, Math.ceil(clb + 1))} (${clbToCefr(clb + 1)}). Theme: ${theme}.
passage: natural spoken French (dialogue or announcement, 60-140 words, names, numbers, a negation, one idiom). items: 4 MCQs in French, kind "mcq", 4 options ≤60 chars, answer_index, item_clb, skill "listening".
Return {"title","passage","items":[...]}`, { temperature: 0.5 });
  if (!set?.passage) throw new Error("listening set: no passage");
  await sendMessage(chatId, `🎧 <b>Écoute — ${esc(set.title ?? "")}</b>\n<i>Une seule écoute, like the exam. Theme: ${esc(theme)}</i>`);
  await sendChatAction(chatId, "record_voice");
  await sendVoice(chatId, await speakFrench(set.passage, "normal"), "▶️");
  await kvSet("last_passage", { passage: set.passage }, 60);
  await startCheck({ chatId, type: "listening_set", title: set.title, items: sanitize(set.items).map((i) => ({ ...i, skill: "listening" })), env, pass_pct: 75, meta: { delivery_id: deliveryId } });
}

export async function sendReadingSet(chatId: number, env = "seated", deliveryId?: number) {
  const clb = (await currentClb()).reading.clb;
  const theme = randomTheme();
  const set = await ask<{ title: string; text: string; items: Item[] }>("EXAMINER",
    `TCF Canada READING set. Learner CLB ${clb.toFixed(1)}; text at CLB ${Math.min(12, Math.ceil(clb + 1))}. Theme: ${theme}.
text: realistic French document (sign, ad, email, forum post or short article, 80-200 words) with level-appropriate connectors. items: 4 MCQs in French, kind "mcq", 4 options ≤60 chars, answer_index, item_clb, skill "reading".
Return {"title","text","items":[...]}`, { temperature: 0.5 });
  if (!set?.text) throw new Error("reading set: no text");
  await sendMessage(chatId, `📰 <b>Lecture — ${esc(set.title ?? "")}</b>\n\n${esc(set.text)}`);
  await startCheck({ chatId, type: "reading_set", title: set.title, items: sanitize(set.items).map((i) => ({ ...i, skill: "reading" })), env, pass_pct: 75, meta: { delivery_id: deliveryId } });
}

/** Model "helpers" come back as strings or {fr,en} objects; render both. */
const helperLine = (h: any) => esc(typeof h === "string" ? h : h && typeof h === "object" ? [h.fr ?? h.expression ?? h.text, h.en ?? h.gloss ?? h.meaning].filter(Boolean).join(" — ") : String(h ?? ""));

export type WritingTask = "micro" | "tcf_w1" | "tcf_w2" | "tcf_w3";
export type SpeakingTask = "micro" | "tcf_s1" | "tcf_s2" | "tcf_s3";

const W_SPEC: Record<WritingTask, string> = {
  micro: "MICRO writing for a beginner: 4-6 French sentences on a personal everyday topic reusing structures at the learner's level; name the 1-2 competencies to use.",
  tcf_w1: "TCF Canada Writing Task 1: 60-120 words, message to a friend/forum (describe, announce, invite). Full exam-style prompt.",
  tcf_w2: "TCF Canada Writing Task 2: 120-150 words, article/blog/report narrating an experience or describing a situation for a wide audience.",
  tcf_w3: "TCF Canada Writing Task 3: TWO short opposing opinion texts (40-60 words each) on a societal topic; ask for 120-180 words comparing them and giving an argued opinion.",
};
const S_SPEC: Record<SpeakingTask, string> = {
  micro: "MICRO speaking: 4-6 simple personal questions to answer aloud in French (30-60 s total); include model answer skeletons.",
  tcf_s1: "TCF Canada Speaking Task 1 (guided interview, 2 min): 5 examiner questions about life, work, plans.",
  tcf_s2: "TCF Canada Speaking Task 2 (interaction, 5.5 min): scenario where the CANDIDATE must ask 8-10 questions to obtain information (enrol, rent, join). Give the scenario card; the goal is to ASK questions.",
  tcf_s3: "TCF Canada Speaking Task 3 (opinion, 4.5 min): a debatable societal question; take and defend a position with examples.",
};

export async function sendWritingTask(chatId: number, task: WritingTask = "micro", deliveryId?: number) {
  const clb = (await currentClb()).writing.clb;
  const p = await ask<{ prompt_fr: string; instructions_en: string; helpers: string[]; target_codes: string[] }>("EXAMINER",
    `${W_SPEC[task]} Learner writing CLB ${clb.toFixed(1)}. Theme: ${randomTheme()}.
Return {"prompt_fr","instructions_en" (word count, time, what graders look for),"helpers":[4-6 expressions with EN gloss],"target_codes":[1-3 competency codes this task should elicit]}`, { temperature: 0.6 });
  if (!p?.prompt_fr) throw new Error("writing task: empty prompt from model");
  const ins = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('writing', ${task}, 'seated', ${String(p.prompt_fr)}) RETURNING id`;
  await kvSet("awaiting", { kind: "writing", submission_id: Number(ins[0].id), task, delivery_id: deliveryId }, 12 * 60);
  await sendMessage(chatId,
    `✍️ <b>Expression écrite — ${task === "micro" ? "micro" : "TCF " + task.slice(4).toUpperCase()}</b>\n\n${esc(p.prompt_fr)}\n\n<i>${esc(p.instructions_en ?? "")}</i>\n\n💡 ${(p.helpers ?? []).map(helperLine).join(" · ")}\n\nReply with your text. Graded against the TCF rubric with a CLB sub-score.`,
    [[{ text: "⏭ Skip", callback_data: "skip:writing" }]]);
}

export async function sendSpeakingTask(chatId: number, task: SpeakingTask = "micro", deliveryId?: number) {
  const clb = (await currentClb()).speaking.clb;
  const p = await ask<{ prompt_fr: string; instructions_en: string; helpers: string[] }>("EXAMINER",
    `${S_SPEC[task]} Learner speaking CLB ${clb.toFixed(1)}. Theme: ${randomTheme()}. Return {"prompt_fr","instructions_en","helpers":[4-6 expressions with EN gloss]}`, { temperature: 0.6 });
  if (!p?.prompt_fr) throw new Error("speaking task: empty prompt from model");
  const ins = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('speaking', ${task}, 'seated', ${String(p.prompt_fr)}) RETURNING id`;
  await kvSet("awaiting", { kind: "speaking", submission_id: Number(ins[0].id), task, delivery_id: deliveryId }, 12 * 60);
  await sendMessage(chatId,
    `🎤 <b>Expression orale — ${task === "micro" ? "micro" : "TCF " + task.slice(4).toUpperCase()}</b>\n\n${esc(p.prompt_fr)}\n\n<i>${esc(p.instructions_en ?? "")}</i>\n\n💡 ${(p.helpers ?? []).map(helperLine).join(" · ")}\n\n🎙 Reply with a voice message.`,
    [[{ text: "⏭ Skip", callback_data: "skip:speaking" }]]);
}

/** Interview: the bot asks, you answer by voice, it follows up (3-5 turns), then grades the whole exchange as one submission. */
export async function startInterview(chatId: number, task: "tcf_s1" | "tcf_s3" = "tcf_s1", deliveryId?: number) {
  const clb = (await currentClb()).speaking.clb;
  const q = await ask<{ opening_fr: string; topic: string }>("EXAMINER",
    `Start a TCF Canada ${task === "tcf_s1" ? "Task 1 guided interview (personal questions)" : "Task 3 opinion discussion"} for a CLB ${clb.toFixed(1)} learner. Theme: ${randomTheme()}. Return {"opening_fr": the examiner's first question in French, "topic"}`, { temperature: 0.7 });
  const ins = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('speaking', ${"interview_" + task.slice(4)}, 'seated', ${String(q.topic ?? q.opening_fr ?? "interview")}) RETURNING id`;
  await kvSet("interview_session", { kind: "interview", submission_id: Number(ins[0].id), task, turns: [{ role: "examiner", text: String(q.opening_fr) }], max_turns: task === "tcf_s1" ? 5 : 4, delivery_id: deliveryId }, 60);
  await sendMessage(chatId, `🎙 <b>Entretien — ${task === "tcf_s1" ? "Tâche 1" : "Tâche 3"}</b>\n<i>Answer each question by voice. I follow up like an examiner, then grade the whole exchange.</i>\n\n🧑‍⚖️ ${esc(String(q.opening_fr))}`, [[{ text: "⏹ End interview", callback_data: "interview:end" }]]);
}

/** Grammar brief + 6-item typed test (Kwiziq-style), seated. */
export async function sendGrammarBrief(chatId: number, code: string, deliveryId?: number) {
  const c = COMPETENCIES.find((x) => x.code === code);
  if (!c) return sendMessage(chatId, `Unknown competency ${code}`);
  const clb = (await currentClb()).writing.clb;
  const g = await authorGrammarTest(code, c.name, c.description + (c.test_focus ? ` Test focus: ${c.test_focus.join("; ")}` : ""), Math.max(2, Math.round(clb)));
  const ex = (g.examples ?? []).filter((e) => e?.fr).map((e) => `• ${esc(e.fr)}\n  <i>${esc(e.en ?? "")}</i>`).join("\n");
  await sendMessage(chatId, `📐 <b>${esc(c.name)}</b>\n\n${esc(g.brief_en ?? "")}\n\n${ex}`, [[{ text: "🧪 Test me (6)", callback_data: `gram:test:${code}${deliveryId ? ":" + deliveryId : ""}` }]]);
  await kvSet("grammar_test:" + code, sanitize(g.items), 12 * 60);
}
export async function startGrammarTest(chatId: number, code: string, deliveryId?: number) {
  const items = await one`SELECT v FROM kv WHERE k = ${"grammar_test:" + code} AND (expires_at IS NULL OR expires_at > now())`;
  if (!items?.v?.length) return sendGrammarBrief(chatId, code, deliveryId);
  const c = COMPETENCIES.find((x) => x.code === code)!;
  await startCheck({ chatId, type: "grammar_test", title: c.name, items: items.v, env: "seated", pass_pct: 80, meta: { competency_code: code, delivery_id: deliveryId } });
}
