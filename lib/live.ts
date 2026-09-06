// "Say it in French" — the learner's own life as training material.
//
// You send an English thought ("I need to buy groceries after work"). The bot doesn't answer it: it makes
// you produce it, then grades what you produced against a natural version, files the errors as grammar
// evidence, and turns the thought into a card so it comes back through FSRS. This is retrieval practice on
// language you actually need, which is the gap a fixed curriculum can never close on its own.
//
// It is deliberately NOT scored as a TCF task: it feeds evidence and cards, not your exam estimate.
import { kvGet, kvSet, kvDel, getLearner, logActivity, bumpErrorPattern } from "./db.js";
import { sendMessage, esc } from "./telegram.js";
import { ask, validCode, competencyName } from "./coach.js";
import { recordEvidence } from "./grammar.js";
import { addCards } from "./srs.js";
import { recordExam } from "./nclc.js";
import { knownMaterial, knownClause, stage } from "./stage.js";
import { localDate } from "./time.js";
import { busy } from "./flow.js";

export type LiveSession = { chatId: number; en: string; started: number };

type LiveGrade = {
  transcript?: string | null;
  verdict: "good" | "partly" | "wrong";
  natural_fr: string;
  literal_note?: string | null;
  clb: number;
  corrections: { original: string; fix: string; why: string; competency_code?: string | null; error_type?: string }[];
  grammar_evidence: { competency_code: string; correct: boolean; excerpt?: string }[];
  card: { front: string; back: string; accept?: string[] } | null;
};

/** Start a challenge from an English thought. Returns false if something else is mid-flight. */
export async function challenge(chatId: number, en: string): Promise<boolean> {
  const b = await busy();
  if (b) { await sendMessage(chatId, `⏳ Finish the ${b} you have open first — then send that thought again.`); return false; }
  const thought = en.trim().replace(/\s+/g, " ").slice(0, 200);
  if (thought.split(/\s+/).length < 2) { await sendMessage(chatId, "Send a whole thought, e.g. <i>I need to buy groceries after work.</i>"); return false; }
  await kvSet("live_session", { chatId, en: thought, started: Date.now() } satisfies LiveSession, 30);
  await sendMessage(chatId, `🇫🇷 <b>Say it in French.</b>\n<i>${esc(thought)}</i>\n\nType it or send a voice note. No hints — guess if you have to.`,
    [[{ text: "🤷 I don't know", callback_data: "live:give" }]]);
  return true;
}

/** Grade a typed or spoken attempt. Returns true if it consumed the input. */
export async function liveAnswer(input: { text?: string; audio?: { data: Uint8Array; mime: string }; give?: boolean }): Promise<boolean> {
  const s = await kvGet<LiveSession>("live_session");
  if (!s) return false;
  await kvDel("live_session");
  const spoken = !!input.audio;
  if (input.give) {
    const g = await grade(s, undefined, undefined);
    await sendMessage(s.chatId, `➡️ <b>${esc(g.natural_fr)}</b>${g.literal_note ? `\n<i>${esc(g.literal_note)}</i>` : ""}`);
    await bank(s, g, "skipped");
    return true;
  }
  await sendMessage(s.chatId, spoken ? "🎧 Listening…" : "🔎 Checking…");
  const g = await grade(s, input.text, input.audio);
  const said = String(g.transcript ?? input.text ?? "");
  const head = g.verdict === "good" ? "✅ Good." : g.verdict === "partly" ? "🟡 Understandable, but not how it's said." : "❌ Not quite.";
  const corr = (g.corrections ?? []).filter((c) => c?.original && c?.fix).slice(0, 4)
    .map((c) => `• <s>${esc(c.original)}</s> → <b>${esc(c.fix)}</b>\n  <i>${esc(c.why ?? "")}${validCode(c.competency_code) ? ` [${esc(competencyName(c.competency_code!))}]` : ""}</i>`).join("\n");
  const natural = g.natural_fr && g.natural_fr.trim().toLowerCase() !== said.trim().toLowerCase();
  await sendMessage(s.chatId,
    `${head}\n${spoken ? `🗣 <i>${esc(said)}</i>\n` : ""}` +
    (natural ? `\n<b>More natural:</b> ${esc(g.natural_fr)}${g.literal_note ? `\n<i>${esc(g.literal_note)}</i>` : ""}\n` : "") +
    (corr ? `\n${corr}` : ""));
  await bank(s, g, said);
  return true;
}

/** Evidence, error patterns and a card — the part that makes this compound instead of evaporating. */
async function bank(s: LiveSession, g: LiveGrade, said: string) {
  const learner = await getLearner();
  const ev = (g.grammar_evidence ?? []).filter((e) => validCode(e.competency_code)).map((e) => ({ ...e, weight: 0.9 }));
  for (const c of g.corrections ?? []) {
    const code = validCode(c.competency_code);
    if (code && !ev.some((e) => e.competency_code === code)) ev.push({ competency_code: code, correct: false, weight: 0.9, excerpt: c.original, correction: c.fix } as any);
    if (!code && c.error_type && c.error_type !== "grammar") await bumpErrorPattern(String(c.why ?? c.error_type).slice(0, 60), String(c.error_type), `${c.original} → ${c.fix}`);
  }
  await recordEvidence("live", null, ev);
  const card = g.card?.front && g.card?.back ? g.card : { front: s.en, back: g.natural_fr, accept: [] };
  const added = await addCards([{ front: card.front.slice(0, 120), back: card.back, accept: card.accept ?? [], kind: "phrase", tags: ["live"] }]);
  await recordExam({ component: said === "skipped" ? "writing" : "speaking", source: "live", item_clb: Math.max(1, Math.min(12, Number(g.clb) || 1)), exam_format: false, weight: 0.5 });
  await logActivity(localDate(learner.tz), "micro", "live_production", 1, true);
  if (added) await sendMessage(s.chatId, `🃏 Saved as a card — this comes back in a few days.`);
}

async function grade(s: LiveSession, text?: string, audio?: { data: Uint8Array; mime: string }): Promise<LiveGrade> {
  const beginner = (await stage()) === "beginner";
  const known = beginner ? knownClause(await knownMaterial(40)) : "";
  return ask<LiveGrade>("GRADER",
    `LIVE PRODUCTION (not a TCF task — this is the learner turning their own thought into French).
English thought: "${s.en}"
${audio ? "The attached audio is their spoken attempt: transcribe it EXACTLY, keeping every error." : text !== undefined ? `Their attempt: "${text}"` : "They gave up — no attempt."}
${beginner ? `The learner is a beginner. ${known}\nIf the natural French needs words they have not met, still give it, but keep it as short and plain as possible.` : ""}
Judge meaning first, form second: a sentence that communicates the thought with a small error is "partly", not "wrong".
Return {"transcript": string|null, "verdict":"good|partly|wrong", "natural_fr": the way a French speaker would actually say it (ONE sentence),
"literal_note": ≤15 words on the difference between their phrasing and the natural one, or null,
"clb": 1-12 estimate for THIS sentence only,
"corrections":[{"original","fix","why":≤15 words,"competency_code":null|CODE,"error_type":"grammar|lexis|register|pronunciation|spelling"}],
"grammar_evidence":[{"competency_code":CODE,"correct":bool,"excerpt"}],
"card":{"front": the English thought,"back": natural_fr,"accept":[acceptable variants]}}`,
    { audio, temperature: 0.2 });
}

/** A question is for the tutor; a statement about your life is something to produce in French. */
export function looksLikeQuestion(t: string): boolean {
  const s = t.trim();
  if (s.endsWith("?")) return true;
  return /^(what|why|how|when|where|who|which|is|are|do|does|did|can|could|should|would|will|explain|tell me|give me|show me|help|translate|difference)\b/i.test(s);
}
