// Generic check engine: gate checks (units), post-drive spot checks (drills), grammar micro-tests,
// placement and surprise retention tests. Items are answered by typing, tapping (MCQ) or voice.
// Nothing is marked passed/logged on the learner's word — only on scored items.
import { sql, one, json, getLearner, kvGet, kvSet, kvDel, logActivity } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, esc, editMessage, type Keyboard } from "./telegram.js";
import { check as checkTyped } from "./answer.js";
import { recordEvidence, markTaught } from "./grammar.js";
import { ask, validCode } from "./coach.js";
import { speakFrench } from "./tts.js";
import { addCards, abortSession } from "./srs.js";
import { localDate } from "./time.js";
import { busy } from "./flow.js";

export type Item = {
  kind: "typed" | "mcq" | "dictation" | "voice";
  prompt: string;                 // shown to learner (EN or FR)
  expected?: string;              // typed/dictation/voice target (FR)
  accept?: string[];
  options?: string[];             // mcq
  answer_index?: number;          // mcq
  competency_code?: string | null;
  item_clb?: number;
  skill?: "listening" | "reading" | "writing" | "speaking";
  en?: string;                    // EN gloss of `expected` (dictation/voice) so a missed item can become a sensible card
  // filled in as it goes
  given?: string; correct?: boolean; verdict?: string;
};
export type CheckType = "unit_gate" | "drill_spot" | "grammar_test" | "placement" | "surprise" | "listening_set" | "reading_set";
export type CheckSession = {
  chatId: number; type: CheckType; ref?: { table: string; id: number }; title: string;
  items: Item[]; pos: number; env: string; started: number; pass_pct: number; meta?: any;
};

export async function startCheck(s: Omit<CheckSession, "pos" | "started">): Promise<boolean> {
  const b = await busy();
  if (b === "check" || b === "interview") {
    await sendMessage(s.chatId, `⏳ Finish the current ${b} first (or /skip to abandon it).`);
    return false;
  }
  if (b === "srs") await abortSession(s.chatId);        // cards can be resumed later; a check is more important
  if (!s.items.length) { await sendMessage(s.chatId, "Couldn't build this check — try again."); return false; }
  const sess: CheckSession = { ...s, pos: 0, started: Date.now() };
  await kvSet("check_session", sess, 180);
  await sendMessage(sess.chatId, `🧪 <b>${esc(sess.title)}</b> — ${sess.items.length} items. Answer each one; I score them.`);
  await sendItem(sess);
  return true;
}

async function sendItem(s: CheckSession): Promise<any> {
  const it = s.items[s.pos];
  const n = `${s.pos + 1}/${s.items.length}`;
  await kvSet("check_session", s, 180);
  const skip = { text: "🤷 Skip", callback_data: `chk:skip:${s.pos}` };
  switch (it.kind) {
    case "typed":
      return sendMessage(s.chatId, `${n} ✍️ ${esc(it.prompt)}\n<i>Type the French.</i>`, [[skip]]);
    case "voice":
      return sendMessage(s.chatId, `${n} 🎤 ${esc(it.prompt)}\n<i>Answer with a voice message (or type it).</i>`, [[skip]]);
    case "dictation": {
      const mp3 = await speakFrench(it.expected!, "normal");
      return sendVoice(s.chatId, mp3, `${n} 🎧 Dictée — type exactly what you hear.`, [[{ text: "🔁 Again (slow)", callback_data: "chk:slow" }, skip]]);
    }
    case "mcq": {
      const kb: Keyboard = (it.options ?? []).slice(0, 4).map((o, i) => [{ text: `${"ABCD"[i]}. ${String(o).slice(0, 56)}`, callback_data: `chk:mcq:${s.pos}:${i}` }]);
      return sendMessage(s.chatId, `${n} ❓ ${esc(it.prompt)}`, kb);
    }
    default:
      // unknown kind slipped through: skip it rather than stall
      Object.assign(it, { given: "(unsupported item)", correct: false, verdict: "wrong" });
      s.pos++;
      return s.pos < s.items.length ? sendItem(s) : finish(s);
  }
}

/** Text, MCQ index, or voice audio for the current item. Returns true if consumed. */
export async function answer(input: { text?: string; mcq?: number; pos?: number; audio?: { data: Uint8Array; mime: string }; skip?: boolean; messageId?: number }): Promise<boolean> {
  const s = await kvGet<CheckSession>("check_session");
  if (!s) return false;
  if (input.pos !== undefined && input.pos !== s.pos) return true;   // stale tap on an earlier question: swallow
  const it = s.items[s.pos];
  let correct = false, verdict = "wrong", given = "";
  // a typed single letter answers an MCQ
  if (it.kind === "mcq" && input.text && /^[a-dA-D]$/.test(input.text.trim())) { input.mcq = "ABCD".indexOf(input.text.trim().toUpperCase()); input.text = undefined; }
  if (input.skip) { given = "(skipped)"; }
  else if (it.kind === "mcq") {
    if (input.mcq === undefined) return false;
    given = it.options?.[input.mcq] ?? String(input.mcq); correct = input.mcq === it.answer_index; verdict = correct ? "exact" : "wrong";
    const line = `${esc(it.prompt)}\n${correct ? "✅" : "❌"} ${esc(given)}${correct ? "" : ` → <b>${esc(it.options?.[it.answer_index ?? 0] ?? "")}</b>`}`;
    if (input.messageId) await editMessage(s.chatId, input.messageId, line); else await sendMessage(s.chatId, line);
  } else if (input.audio || (it.kind === "voice" && input.text !== undefined)) {
    const r = await ask<{ transcript: string; correct: boolean; note: string }>("EXAMINER",
      `${input.audio ? "Transcribe this French audio exactly." : `The learner typed: "${input.text}".`} Expected answer: "${it.expected}" (accepted variants: ${JSON.stringify(it.accept ?? [])}). Is the learner's answer correct in meaning AND form (minor pronunciation accent tolerated, wrong words/endings not)? Return {"transcript","correct","note": ≤12 words}.`,
      { audio: input.audio, temperature: 0 });
    given = String(r.transcript ?? input.text ?? ""); correct = !!r.correct; verdict = correct ? "exact" : "wrong";
    await sendMessage(s.chatId, `${correct ? "✅" : "❌"} <i>${esc(given)}</i>${correct ? "" : `\n→ <b>${esc(it.expected ?? "")}</b>`}${r.note ? `\n${esc(String(r.note))}` : ""}`);
  } else if (input.text !== undefined) {
    given = input.text;
    const v = checkTyped(given, it.expected ?? "", it.accept ?? []);
    // "close" (typo-level) only counts when no grammar competency is being tested and it isn't a dictation:
    // a one-letter ending error IS the grammar error.
    verdict = v; correct = v === "exact" || (v === "close" && it.kind !== "dictation" && !it.competency_code);
    await sendMessage(s.chatId, v === "exact" ? `✅ <b>${esc(it.expected ?? "")}</b>` : v === "close" ? `🟡 Almost — <b>${esc(it.expected ?? "")}</b>` : `❌ → <b>${esc(it.expected ?? "")}</b>`);
  } else return false;

  Object.assign(it, { given, correct, verdict });
  s.pos++;
  if (s.pos < s.items.length) { await sendItem(s); return true; }
  await finish(s);
  return true;
}

export async function replaySlow() {
  const s = await kvGet<CheckSession>("check_session");
  const it = s?.items[s.pos];
  if (!s || !it || it.kind !== "dictation") return;
  await sendVoice(s.chatId, await speakFrench(it.expected!, "slow"), "🐢 lent");
}

async function finish(s: CheckSession): Promise<void> {
  await kvDel("check_session");
  const learner = await getLearner();
  const n = s.items.length, ok = s.items.filter((i) => i.correct).length;
  const pct = Math.round((ok / n) * 1000) / 10;
  const passed = pct >= s.pass_pct;
  const mins = Math.max(1, Math.round((Date.now() - s.started) / 60000));
  const date = localDate(learner.tz);

  // evidence: grammar-tagged items; weight by item kind
  const weightOf = (k: Item["kind"]) => k === "mcq" ? 0.4 : k === "dictation" ? 0.6 : 0.8;
  await recordEvidence(s.type, s.ref?.id ?? null, s.items.filter((i) => i.competency_code).map((i) => ({
    competency_code: i.competency_code!, correct: !!i.correct, weight: weightOf(i.kind), excerpt: i.given, correction: i.expected })));
  // receptive items -> quiz_results (feeds listening/reading CLB estimates)
  for (const i of s.items) if (i.skill === "listening" || i.skill === "reading")
    await sql`INSERT INTO quiz_results (skill, item_clb, correct, unit_id, question, environment) VALUES (${i.skill}::skill, ${i.item_clb ?? 3}, ${!!i.correct}, ${s.ref?.table === "resource_units" ? s.ref.id : null}, ${i.prompt}, ${s.env}::environment)`;
  // missed items -> cards
  // missed items -> cards (dictation/voice only when we have an EN gloss, otherwise the card front would be "Dictée")
  const missed = s.items.filter((i) => !i.correct && i.expected && i.kind !== "mcq" && (i.kind === "typed" || i.en));
  const added = await addCards(missed.map((i) => ({ front: (i.kind === "typed" ? i.prompt.replace(/^.*?:\s*/, "") : i.en!).slice(0, 120), back: i.expected!, accept: i.accept, kind: i.competency_code ? "grammar" : "phrase", competency_code: i.competency_code ?? null, tags: [s.type] })));

  let tail = "";
  switch (s.type) {
    case "unit_gate": {
      await sql`INSERT INTO unit_checks (unit_id, check_type, items, score_pct, passed, environment) VALUES (${s.ref!.id}, ${s.meta?.check_type ?? "mixed"}, ${json(s.items)}::jsonb, ${pct}::numeric, ${passed}, ${s.env}::environment)`;
      await sql`UPDATE resource_units SET attempts = attempts + 1, best_score = GREATEST(COALESCE(best_score,0), ${pct}), last_used = now(),
                status = CASE WHEN ${passed}::boolean THEN (CASE WHEN ${pct}::numeric >= 95 AND attempts >= 1 THEN 'mastered' ELSE 'passed' END) ELSE 'attempted' END WHERE id = ${s.ref!.id}`;
      tail = passed ? "Unit passed — it advances." : "Not yet — this unit comes back tomorrow with the lines you missed.";
      break;
    }
    case "drill_spot": {
      await sql`INSERT INTO drill_sessions (drill_id, spot_check, score_pct) VALUES (${s.ref!.id}, ${json(s.items)}::jsonb, ${pct}::numeric)`;
      await kvDel("spot_pending");
      tail = passed ? "Drill retained." : "Weak retention — the planner will re-drill these forms.";
      break;
    }
    case "grammar_test": {
      if (s.meta?.competency_code) await markTaught(s.meta.competency_code);
      tail = passed ? "Competency evidence recorded." : "Recorded — expect this point in tomorrow's drive drill.";
      break;
    }
    case "placement": {
      await sql`UPDATE learner SET placement_done = TRUE WHERE id = 1`;
      const { placementEstimate } = await import("./progress.js");
      tail = await placementEstimate(s.items);
      break;
    }
    default: tail = "";
  }
  await logActivity(date, s.env, s.type, mins, true, s.ref);
  await sendMessage(s.chatId, `${passed ? "✅" : "🔁"} <b>${esc(s.title)}: ${ok}/${n} (${pct}%)</b> · ${mins} min\n${esc(tail)}${added ? `\n🃏 ${added} cards added from misses.` : ""}`);
  const { onItemDone } = await import("./deliver.js");
  await onItemDone(s.type);
}

// ------------------------------------------------------------------ authors
/** EXAMINER writes a gate check for a unit (Assimil lesson / podcast / news). */
export async function authorUnitGate(unit: any, env: string, missedLines?: string[]): Promise<{ items: Item[]; check_type: string }> {
  const isText = unit.payload?.dialogue?.length;
  const spec = isText
    ? `Unit = ${unit.resource_id === "assimil" ? "Assimil" : "beginner"} lesson ${unit.seq} "${unit.title}". Dialogue: ${JSON.stringify(unit.payload.dialogue)}. Notes: ${unit.payload.notes ?? ""}.
Write 5 items: 3 typed back-translations (EN prompt -> exact FR line from the dialogue; accept natural variants), 1 dictation (a dialogue line ≤10 words), 1 typed transform (change person/tense/negation of a dialogue line, tagged to the competency it tests${unit.payload?.codes?.length ? `; lesson codes: ${unit.payload.codes.join(", ")}` : ""}). Prompts in ENGLISH (the learner is a beginner).${missedLines?.length ? ` Include these previously missed lines: ${JSON.stringify(missedLines)}.` : ""}`
    : `Unit = ${unit.resource_id} episode "${unit.title}". Summary/description: ${unit.payload?.summary ?? unit.payload?.description ?? ""}. Key vocab: ${JSON.stringify(unit.payload?.key_vocab ?? [])}.
Write 4 items: 2 comprehension MCQs in French on the topic (4 options each, based only on the summary), 1 typed vocab item (EN -> FR from key vocab), 1 voice item: "Résume l'épisode en deux phrases" (expected = a model 2-sentence summary; accept = []).`;
  const r = await ask<{ items: Item[] }>("EXAMINER", `${spec}\nEnvironment: ${env} (patrol = short typed/tap answers only).
Return {"items":[{"kind":"typed|mcq|dictation|voice","prompt","expected","en":EN gloss of expected,"accept":[],"options":[],"answer_index","competency_code":null|CODE,"item_clb":number,"skill":"listening|reading|null"}]}`, { temperature: 0.3 });
  return { items: sanitize(r.items), check_type: isText ? "back_translation" : "recall_qna" };
}

/** EXAMINER writes a grammar brief + 6-item test for a competency. */
export async function authorGrammarTest(code: string, name: string, description: string, clb: number) {
  return ask<{ brief_en: string; examples: { fr: string; en: string }[]; items: Item[] }>("EXAMINER",
    `Competency ${code} — ${name}. ${description}. Learner CLB ${clb}.
Write: brief_en (≤150 words, the rule, one memory trick, the classic mistake), examples (4 FR/EN pairs), items (6 typed items: fill-in / transform / EN->FR sentence, each tagged competency_code "${code}", with expected + accept variants; item 5 and 6 must be full-sentence production).
Return {"brief_en","examples":[{"fr","en"}],"items":[{"kind":"typed","prompt","expected","accept":[],"competency_code":"${code}","item_clb":${clb}}]}`, { temperature: 0.3 });
}

/** Placement: 12 adaptive-ish items spanning CLB 1-6 across skills (served in order; stops are handled by pass logic later). */
export async function authorPlacement() {
  const r = await ask<{ items: Item[] }>("EXAMINER",
    `Write the day-one placement test: 12 items, difficulty rising from CLB 1 to CLB 6, mixing: 4 reading MCQs (short FR text in the prompt, 4 options), 3 dictations (short sentences, rising length), 4 typed EN->FR sentences (tagged to competency codes: TNS_PRESENT_REG, TNS_PASSE_COMP, INT_TROIS_FORMES, TNS_INDICATEURS_TEMPS — the last one must test depuis + présent), 1 voice item ("Présentez-vous en 3 phrases", expected = a model answer).
Return {"items":[...]} using kinds typed|mcq|dictation|voice with expected/en (EN gloss)/accept/options/answer_index/competency_code/item_clb/skill.`, { temperature: 0.3 });
  return sanitize(r.items);
}

/** Surprise retention test from material covered in the last 3 weeks. */
export async function authorSurprise(recent: any) {
  const r = await ask<{ items: Item[] }>("EXAMINER",
    `Write a 10-item surprise retention test from ONLY this recently covered material (units, competencies, cards): ${JSON.stringify(recent).slice(0, 12000)}.
Mix: 4 typed EN->FR, 2 dictations, 2 MCQ (listening-style, FR question), 2 typed grammar transforms tagged to competency codes. Return {"items":[...]}`, { temperature: 0.4 });
  return sanitize(r.items);
}

const KINDS = new Set(["typed", "mcq", "dictation", "voice"]);
export function sanitize(items: Item[]): Item[] {
  return (items ?? [])
    .filter((i) => i && typeof i.prompt === "string" && i.prompt.trim() && KINDS.has(i.kind))
    .filter((i) => i.kind === "mcq"
      ? Array.isArray(i.options) && i.options.length >= 2 && Number.isInteger(i.answer_index) && i.answer_index! >= 0 && i.answer_index! < i.options.length
      : typeof i.expected === "string" && i.expected.trim())
    .map((i) => ({ ...i, prompt: String(i.prompt), expected: i.expected ? String(i.expected) : undefined, competency_code: validCode(i.competency_code),
      accept: Array.isArray(i.accept) ? i.accept.map(String) : [], item_clb: Number(i.item_clb) || 3, en: i.en ? String(i.en) : undefined }))
    .slice(0, 15);
}
