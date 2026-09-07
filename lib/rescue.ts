// The safety net under every audio item.
//
// Rule (ARCHITECTURE §10): no voice note leaves this bot without a way back to comprehensible text.
// A French sentence you can't decode is not input — it's noise, and noise is what makes the bot
// feel like an interrogation. Every audio message therefore carries "🤷 Didn't catch it".
//
// Two invariants:
//   1. The net never depends on a network call succeeding. Text goes first; audio is best-effort in
//      a try/catch. A rescue that can fail is not a safety net — and it would fail precisely when
//      the Gemini quota is exhausted, which is when you need it most.
//   2. Pressing it is EVIDENCE, not just a UI event. See recordRescue().
import { sql, one, kvGet, kvSet } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc, type InlineButton } from "./telegram.js";
import { speakDialogue } from "./tts.js";
import { splitTelegram } from "./text.js";

const ENVS = ["patrol", "driving", "seated", "micro"];
const safeEnv = (e?: string) => (e && ENVS.includes(e) ? e : "patrol");

export const huh = (kind: "unit" | "drill", id: number, env?: string): InlineButton =>
  ({ text: "🤷 Didn't catch it", callback_data: `huh:${kind}:${id}:${safeEnv(env)}` });

/**
 * A rescue press is the strongest free signal the system gets: unprompted, unambiguous
 * "I could not process this". It writes two rows and deliberately refuses to write a third.
 */
async function recordRescue(u: any, env: string) {
  const key = "huh_logged:" + u.id;
  if (await kvGet(key)) return;                       // a double tap is not a second failure
  await kvSet(key, { at: Date.now() }, 6 * 60);

  // (a) A receptive failure IS a receptive observation. updateReceptiveEstimates() reads
  //     quiz_results nightly, so three of these genuinely move the listening estimate down.
  await sql`INSERT INTO quiz_results (skill, item_clb, correct, unit_id, question, environment)
            VALUES ('listening'::skill, ${Number(u.clb_level ?? 2)}, false, ${u.id},
                    ${"could not follow the audio — " + String(u.title ?? u.resource_id)}, ${env}::environment)`;

  // (b) The recurring-problem counter that selector rule 2 (remediation) reads at count >= 3.
  //     Keyed by what the audio actually carried, so three failures on past-narrative audio
  //     collapse onto one category instead of three unrelated ones.
  const codes: string[] = (u.payload?.codes ?? []).filter(Boolean);
  const cat = `comprehension:audio:${codes[0] ?? `${u.resource_id}_${u.seq ?? u.id}`}`;
  await sql`INSERT INTO error_patterns (category, kind, example, count)
            VALUES (${cat}, 'comprehension', ${String(u.payload?.dialogue?.[0]?.fr ?? u.title ?? "")}, 1)
            ON CONFLICT (category) DO UPDATE SET count = error_patterns.count + 1, last_seen = now()`;

  // (c) NOT written: grammar_evidence. Failing to parse the passé composé at native speed is not
  //     evidence that you don't know the passé composé — you may write it perfectly. That evidence
  //     belongs on module_state(module, 'listening'), which does not exist yet (ARCHITECTURE §3.5).
  //     Writing it into the grammar grid would corrupt a competency score with a listening problem,
  //     and the grid is currently the most trustworthy structure in the system. It waits for P0.
}

/** Best-effort audio. Never throws: the text above it is the actual safety net. */
async function tryVoice(chatId: number, send: () => Promise<any>, onFail: string) {
  try { await sendChatAction(chatId, "record_voice"); await send(); return true; }
  catch (e: any) {
    console.error("rescue audio", e);
    const quota = /quota|429|RESOURCE_EXHAUSTED/i.test(String(e?.message ?? e));
    await sendMessage(chatId, quota
      ? `🔇 ${onFail} — the audio can't be rebuilt right now (Gemini's daily quota is used up; it resets at 03:00 Toronto). The text above is the important part: read it out loud twice.`
      : `🔇 ${onFail} — couldn't attach the audio just now. The text above is the important part: read it out loud twice.`);
    return false;
  }
}

/** Line-by-line FR/EN, then the slow recording (pre-warmed in tts_cache by the nightly planner). */
export async function rescueUnit(chatId: number, unitId: number, env = "patrol") {
  const u = await one`SELECT * FROM resource_units WHERE id = ${unitId}`;
  if (!u) return sendMessage(chatId, "That lesson isn't here any more.");
  await recordRescue(u, safeEnv(env)).catch((e) => console.error("recordRescue", e));

  const d: { fr: string; en: string }[] = u.payload?.dialogue ?? [];

  if (!d.length) {                                     // podcast / news episode: nothing to unpack line by line
    const p = u.payload ?? {};
    const vocab = (p.key_vocab ?? []).map((v: any) => `• <b>${esc(v.fr)}</b> — ${esc(v.en)}`).join("\n");
    return sendMessage(chatId,
      `🤷 <b>Before you listen again</b>\n\n<i>${esc(p.summary ?? u.title ?? "")}</i>\n\n${vocab}\n\n<i>Don't try to catch every word. Listen for those, and for who is speaking to whom.</i>`,
      [[{ text: "▶️ Keep going", callback_data: "more:next" }]]);
  }

  const body = d.map((l, i) => `${i + 1}. <b>${esc(l.fr)}</b>\n    <i>${esc(l.en)}</i>`).join("\n");
  for (const c of splitTelegram(`🤷 <b>No problem — here it is line by line</b>\n\n${body}`)) await sendMessage(chatId, c);

  const cap = "🐢 Slowly. Read along with the lines above, then say each one out loud.";
  if (u.audio_slow) await tryVoice(chatId, () => sendVoiceById(chatId, u.audio_slow, cap), "Slow version");
  else await tryVoice(chatId, async () => {
    const id = await sendVoice(chatId, await speakDialogue(d, "slow"), cap);
    await sql`UPDATE resource_units SET audio_slow = ${id} WHERE id = ${unitId}`;
  }, "Slow version");

  await sendMessage(chatId, "Still fuzzy? I'll teach the whole lesson properly — new words, the patterns, guided practice.", [
    [{ text: "📖 Teach me this lesson", callback_data: `unit:teach:${unitId}` }],
    [{ text: "▶️ Keep going", callback_data: "more:next" }],
  ]);
}

/** A drill is audio-only by design, so this prints its prompts and answers as text. No audio, so nothing to fail. */
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
