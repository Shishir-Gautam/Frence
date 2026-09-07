// The safety net under every audio item.
//
// Rule (ARCHITECTURE §10): no voice note leaves this bot without a way back to comprehensible text.
// A French sentence you can't decode is not input — it's noise, and noise is what makes the bot
// feel like an interrogation. Every audio message therefore carries "🤷 Didn't catch it".
import { sql, one } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc, type InlineButton } from "./telegram.js";
import { speakDialogue } from "./tts.js";
import { splitTelegram } from "./text.js";

export const huh = (kind: "unit" | "drill", id: number): InlineButton =>
  ({ text: "🤷 Didn't catch it", callback_data: `huh:${kind}:${id}` });

/** Line-by-line FR/EN, then the slow recording. Reuses the cached audio_slow file_id — no extra TTS cost. */
export async function rescueUnit(chatId: number, unitId: number) {
  const u = await one`SELECT * FROM resource_units WHERE id = ${unitId}`;
  if (!u) return sendMessage(chatId, "That lesson isn't here any more.");
  const d: { fr: string; en: string }[] = u.payload?.dialogue ?? [];

  if (!d.length) {                                     // podcast / news episode: no dialogue to unpack
    const p = u.payload ?? {};
    const vocab = (p.key_vocab ?? []).map((v: any) => `• <b>${esc(v.fr)}</b> — ${esc(v.en)}`).join("\n");
    return sendMessage(chatId,
      `🤷 <b>Before you listen again</b>\n\n<i>${esc(p.summary ?? u.title ?? "")}</i>\n\n${vocab}\n\n<i>Don't try to catch every word — listen for those, and for who is speaking to whom.</i>`,
      [[{ text: "▶️ Keep going", callback_data: "more:next" }]]);
  }

  const body = d.map((l, i) => `${i + 1}. <b>${esc(l.fr)}</b>\n    <i>${esc(l.en)}</i>`).join("\n");
  for (const c of splitTelegram(`🤷 <b>No problem — here it is line by line</b>\n\n${body}`)) await sendMessage(chatId, c);

  await sendChatAction(chatId, "record_voice");
  const cap = "🐢 Slowly. Read along with the lines above, then say each one out loud.";
  if (u.audio_slow) await sendVoiceById(chatId, u.audio_slow, cap);
  else {
    const id = await sendVoice(chatId, await speakDialogue(d, "slow"), cap);
    await sql`UPDATE resource_units SET audio_slow = ${id} WHERE id = ${unitId}`;
  }

  await sendMessage(chatId, "Still fuzzy? I'll teach the whole lesson properly — new words, the patterns, guided practice.", [
    [{ text: "📖 Teach me this lesson", callback_data: `unit:teach:${unitId}` }],
    [{ text: "▶️ Keep going", callback_data: "more:next" }],
  ]);
}

/** A drill is audio-only by design, so this prints its prompts and answers as text. */
export async function rescueDrill(chatId: number, drillId: number) {
  const d = await one`SELECT title, script FROM drills WHERE id = ${drillId}`;
  if (!d) return sendMessage(chatId, "That drill isn't here any more.");
  const steps = (d.script as any[]).filter((s) => s && ["teach", "prompt", "answer", "recap"].includes(s.type));
  const body = steps.map((s) =>
    s.type === "prompt" ? `❓ ${esc(s.en ?? s.fr ?? "")}` :
    s.type === "answer" ? `➡️ <b>${esc(s.fr ?? "")}</b>` :
    `<i>${esc(s.en ?? s.fr ?? "")}</i>`).join("\n");
  for (const c of splitTelegram(`🤷 <b>${esc(d.title)} — in writing</b>\n<i>Read it through, then play the audio again. Answer out loud in the pauses.</i>\n\n${body}`)) await sendMessage(chatId, c);
  await sendMessage(chatId, "That's the whole drill.", [[{ text: "▶️ Keep going", callback_data: "more:next" }]]);
}
