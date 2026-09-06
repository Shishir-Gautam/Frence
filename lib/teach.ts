// TEACH → PRACTICE → CHECK for a lesson unit.
//
//  1. Teach   : goal in English, new words (with a tip each + audio), the dialogue (FR/EN + slow/natural audio),
//               "what to notice" (the 1-2 patterns explained in English with examples).
//  2. Practice: 4 guided items with a hint. NOT scored, no cards, no evidence — you see the answer and a one-line why.
//  3. Check   : only after practice — the scored 5-item gate (checks.ts).
//
// Lesson payloads authored before this existed (no vocab/practice/goal) are enriched once, on first use.
import { sql, one, json, kvGet, kvSet, kvDel } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc, type Keyboard } from "./telegram.js";
import { ask, tutor } from "./coach.js";
import { speakFrench, speakDialogue } from "./tts.js";
import { check as checkTyped } from "./answer.js";
import { splitTelegram } from "./text.js";
import { knownMaterial, knownClause } from "./stage.js";

export type Vocab = { fr: string; en: string; tip?: string };
export type Practice = { prompt_en: string; hint: string; answer_fr: string; accept?: string[]; why: string };
export type Lesson = { goal?: string; vocab?: Vocab[]; dialogue: { fr: string; en: string }[]; notes?: string; practice?: Practice[]; exercises?: any[]; codes?: string[]; audio_vocab?: string };

/** Make sure a lesson has goal / vocab / practice (older lessons and Assimil lessons don't). */
export async function enrichLesson(u: any): Promise<Lesson> {
  const p: Lesson = u.payload ?? {};
  if (p.goal && p.vocab?.length && p.practice?.length) return p;
  const known = await knownMaterial();
  const r = await ask<{ goal: string; vocab: Vocab[]; notes: string; practice: Practice[] }>("EXAMINER",
    `Lesson ${u.seq} "${u.title}". Dialogue: ${JSON.stringify(p.dialogue)}. Existing notes: ${p.notes ?? "(none)"}.
${knownClause(known)}
Produce the TEACHING layer for an absolute beginner (English explanations):
- goal: one sentence, "After this lesson you can …".
- vocab: 8-12 new words/chunks from the dialogue, each {fr, en, tip} where tip is a ≤10-word pronunciation or usage tip (e.g. "final -s silent", "liaison: vous‿êtes").
- notes: ≤150 words, the 1-2 patterns this lesson introduces, each with 3 example sentences built ONLY from the dialogue's words. Plain text, no markdown.
- practice: 4 guided items {prompt_en, hint, answer_fr, accept[], why} — the hint names the pattern or gives the first word; why is ≤15 words. Items reuse only dialogue words; item 4 recombines two lines.
Return {"goal","vocab","notes","practice"}`, { temperature: 0.3 });
  const merged: Lesson = { ...p, goal: r.goal ?? p.goal, vocab: r.vocab?.length ? r.vocab : p.vocab, notes: r.notes || p.notes, practice: r.practice?.length ? r.practice : p.practice };
  await sql`UPDATE resource_units SET payload = ${json(merged)}::jsonb WHERE id = ${u.id}`;
  return merged;
}

/** 1a. The two-minute start: goal + new words + their audio. Enough to begin without deciding anything. */
export async function teachIntro(chatId: number, u: any) {
  const p = await enrichLesson(u);
  const isAssimil = u.resource_id === "assimil";
  await sendMessage(chatId, `📖 <b>${isAssimil ? "Assimil" : "Leçon"} ${u.seq} — ${esc(u.title ?? "")}</b>\n🎯 ${esc(p.goal ?? "")}\n\n<i>Three steps: learn → practice (not scored) → check (scored). ~20 min.</i>`);
  if (p.vocab?.length) {
    await sendMessage(chatId, `🔤 <b>New words</b>\n${p.vocab.map((v) => `• <b>${esc(v.fr)}</b> — ${esc(v.en)}${v.tip ? `  <i>(${esc(v.tip)})</i>` : ""}`).join("\n")}`);
    await sendChatAction(chatId, "record_voice");
    if (p.audio_vocab) await sendVoiceById(chatId, p.audio_vocab, "🔤 the words, slowly");
    else {
      const id = await sendVoice(chatId, await speakFrench(p.vocab.map((v) => v.fr).join(". "), "slow"), "🔤 the words, slowly");
      await sql`UPDATE resource_units SET payload = payload || ${json({ audio_vocab: id })}::jsonb WHERE id = ${u.id}`;
    }
  }
  await kvSet("intro_sent:" + u.id, { at: Date.now() }, 12 * 60);
}

/** 1. TEACH */
export async function teach(chatId: number, u: any, env: string) {
  const p = await enrichLesson(u);
  const d = p.dialogue ?? [];
  if (!(await kvGet("intro_sent:" + u.id))) await teachIntro(chatId, u);
  else await sendMessage(chatId, `▶️ <b>Leçon ${u.seq}</b> — continuing.`);

  // dialogue + audio
  const body = d.map((l, i) => `${i + 1}. ${esc(l.fr)}\n    <i>${esc(l.en)}</i>`).join("\n");
  for (const c of splitTelegram(`💬 <b>The dialogue</b>\n${body}`)) await sendMessage(chatId, c);
  await sendChatAction(chatId, "record_voice");
  if (u.audio_slow) await sendVoiceById(chatId, u.audio_slow, `🐢 slow — read along, then repeat each line`);
  else { const id = await sendVoice(chatId, await speakDialogue(d, "slow"), `🐢 slow — read along, then repeat each line`); await sql`UPDATE resource_units SET audio_slow = ${id} WHERE id = ${u.id}`; }
  if (u.audio_normal) await sendVoiceById(chatId, u.audio_normal, `🐇 natural speed — listen twice`);
  else { const id = await sendVoice(chatId, await speakDialogue(d, "normal"), `🐇 natural speed — listen twice`); await sql`UPDATE resource_units SET audio_normal = ${id} WHERE id = ${u.id}`; }

  // what to notice
  if (p.notes) for (const c of splitTelegram(`📝 <b>What to notice</b>\n${esc(String(p.notes))}`)) await sendMessage(chatId, c);

  await sendMessage(chatId, `${env === "patrol" ? "Walk, listen, repeat out loud. " : ""}When the lines feel familiar:`, [[{ text: "✏️ Practice (not scored)", callback_data: `unit:practice:${u.id}` }]]);
}

/** 2. PRACTICE — guided, unscored. */
export async function startPractice(chatId: number, unitId: number, cb: string) {
  const u = await one`SELECT * FROM resource_units WHERE id = ${unitId}`;
  if (!u) return;
  const p = await enrichLesson(u);
  const items = (p.practice ?? []).filter((x) => x?.prompt_en && x?.answer_fr).slice(0, 5);
  if (!items.length) return sendMessage(chatId, "No practice for this lesson — go straight to the check.", [[{ text: "🧪 Check me", callback_data: cb }]]);
  await kvSet("practice_session", { chatId, unitId, items, pos: 0, cb, ok: 0 }, 60);
  await sendMessage(chatId, "✏️ <b>Practice</b> — nothing here is recorded. Try, look at the answer, move on.");
  await sendPracticeItem();
}

async function sendPracticeItem() {
  const s = await kvGet<any>("practice_session");
  if (!s) return;
  const it: Practice = s.items[s.pos];
  await sendMessage(s.chatId, `${s.pos + 1}/${s.items.length} ✏️ ${esc(it.prompt_en)}\n💡 <i>${esc(it.hint)}</i>`, [[{ text: "👁 Show answer", callback_data: "prac:show" }]]);
}

/** Typed reply during practice. Returns true if consumed. */
export async function practiceAnswer(text?: string, show = false): Promise<boolean> {
  const s = await kvGet<any>("practice_session");
  if (!s) return false;
  const it: Practice = s.items[s.pos];
  if (show) await sendMessage(s.chatId, `➡️ <b>${esc(it.answer_fr)}</b>\n<i>${esc(it.why)}</i>`);
  else {
    const v = checkTyped(text ?? "", it.answer_fr, it.accept ?? []);
    if (v !== "wrong") s.ok++;
    await sendMessage(s.chatId, `${v === "exact" ? "✅" : v === "close" ? "🟡 Almost —" : "❌ Not quite —"} <b>${esc(it.answer_fr)}</b>\n<i>${esc(it.why)}</i>`);
  }
  s.pos++;
  if (s.pos < s.items.length) { await kvSet("practice_session", s, 60); await sendPracticeItem(); return true; }
  await kvDel("practice_session");
  await sendMessage(s.chatId, `Practice done (${s.ok}/${s.items.length} on the first try). ${s.ok >= s.items.length - 1 ? "You're ready." : "Re-listen once if you want, then:"}`,
    [[{ text: "🧪 Check me (scored)", callback_data: s.cb }], [{ text: "🔁 Practice again", callback_data: `unit:practice:${s.unitId}` }]]);
  return true;
}

/** "Why?" on a missed answer: a short explanation from the tutor using only known material. */
export async function explainLastMiss(chatId: number) {
  const m = await kvGet<{ given: string; expected: string; prompt: string }>("last_miss");
  if (!m) return sendMessage(chatId, "Nothing to explain yet.");
  const known = await knownMaterial();
  const txt = await tutor(`Beginner learner. Prompt: "${m.prompt}". They wrote: "${m.given}". Correct: "${m.expected}". In ≤60 words of plain English, explain the ONE most important difference and the rule behind it. Use only words from: ${known.lines.slice(-30).join(" | ")}.`);
  await sendMessage(chatId, `💡 ${esc(txt)}`);
}
