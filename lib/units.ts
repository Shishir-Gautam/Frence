// Resource router runtime: materialise units (Assimil lessons, podcast/news episodes), render them for an
// environment, and hand off to the gate check. A unit only advances through unit_checks.
import { sql, one, json, getLearner, kvGet, kvSet, kvDel } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc, type Keyboard } from "./telegram.js";
import { speakDialogue } from "./tts.js";
import { ask } from "./coach.js";
import { addCards } from "./srs.js";
import { startCheck, authorUnitGate } from "./checks.js";
import { splitTelegram } from "./text.js";
import { knownMaterial, knownClause } from "./stage.js";

export async function getUnit(id: number) { return one`SELECT * FROM resource_units WHERE id = ${id}`; }

/** Next unit for a resource: attempted (retest) first, then scheduled/unseen in order. For feeds, fetch a new episode. */
export async function nextUnit(resourceId: string) {
  const u = await one`SELECT * FROM resource_units WHERE resource_id = ${resourceId} AND status IN ('attempted','scheduled','unseen')
                       ORDER BY (status = 'attempted') DESC, seq NULLS LAST, id LIMIT 1`;
  if (u) return u;
  const r = await one`SELECT * FROM resources WHERE id = ${resourceId}`;
  if (r?.feed_url) return ingestLatestEpisode(resourceId, r.feed_url);
  if (resourceId === "coach_lessons") return authorCoachLesson();
  return undefined;
}

// The beginner curriculum (content/curriculum/beginner.json) drives bot-authored lessons: one unit = one lesson.
import curriculum from "../content/curriculum/beginner.json" with { type: "json" };
export const CURRICULUM = curriculum as { stages: { id: number; name: string; units: string; clb: string; focus: string }[]; units: { n: number; stage: number; title: string; can_do: string; codes: string[]; vocab: string[]; pron: string; first_step: string }[] };
export const unitSpec = (n: number) => CURRICULUM.units[Math.min(n, CURRICULUM.units.length) - 1];

export async function authorCoachLesson() {
  // self-heal: the toolbox row may be missing on a database seeded before coach_lessons existed
  if (!(await one`SELECT 1 FROM resources WHERE id = 'coach_lessons'`)) { const { seedToolbox } = await import("./seed.js"); await seedToolbox(); }
  const last = await one`SELECT COALESCE(MAX(seq),0) AS s FROM resource_units WHERE resource_id = 'coach_lessons'`;
  const seq = Number(last?.s ?? 0) + 1;
  if (seq > CURRICULUM.units.length) return undefined;           // curriculum finished → the core planner takes over
  const spec = unitSpec(seq);
  const step = { theme: `${spec.title} — ${spec.can_do} Required vocabulary to teach (use every item): ${spec.vocab.join(", ")}. Pronunciation focus: ${spec.pron}.`, codes: spec.codes };
  const clb = spec.stage === 1 ? 1 : spec.stage === 2 ? 2 : 3;
  const known = await knownMaterial();
  const r = await ask<{ title: string; goal: string; vocab: { fr: string; en: string; tip: string }[]; dialogue: { fr: string; en: string }[]; notes: string; practice: { prompt_en: string; hint: string; answer_fr: string; accept: string[]; why: string }[]; exercises: { fr: string; en: string }[] }>("EXAMINER",
    `Write beginner lesson ${seq} for an absolute-beginner learner (CLB ${clb}) in the style of an Assimil lesson. Theme: ${step.theme}. Grammar codes to seed: ${step.codes.join(", ")}.
${seq > 1 ? knownClause(known) + " You may add at most 10 NEW words in this lesson; everything else must be already-known material." : "This is lesson 1: the learner knows nothing."}
Return JSON with:
- title (French, ≤6 words)
- goal: one sentence in English, "After this lesson you can …"
- vocab: 8-12 new words/chunks {fr, en, tip} (tip ≤10 words: pronunciation or usage)
- dialogue: 8-10 short natural lines (two-person exchange), everyday Canadian-French register, one new structure at a time, each line ≤12 words, faithful English translation {fr, en}
- notes: ≤150 words in English: the 1-2 patterns introduced, each with 3 example sentences built only from the dialogue's words; pronunciation tips for liaison/nasal vowels. Plain text.
- practice: 4 guided items {prompt_en, hint, answer_fr, accept[], why(≤15 words)} reusing only dialogue words; item 4 recombines two lines
- exercises: 4 EN→FR sentences {fr, en} that recombine the lesson's words`, { temperature: 0.6 });
  const ins = await sql`INSERT INTO resource_units (resource_id, seq, title, clb_level, skills, payload)
    VALUES ('coach_lessons', ${seq}, ${String(spec.title)}, ${clb}, ${["listening", "reading"]}, ${json({ goal: r.goal ?? spec.can_do, vocab: r.vocab, dialogue: r.dialogue, notes: r.notes, practice: r.practice, exercises: r.exercises, codes: step.codes, first_step: spec.first_step, stage: spec.stage })}::jsonb) RETURNING *`;
  return ins[0];
}

/** Minimal RSS parsing (title, enclosure url, description) - no XML lib needed for these feeds. */
export async function ingestLatestEpisode(resourceId: string, feedUrl: string) {
  const res = await fetch(feedUrl, { headers: { "user-agent": "french-bot/2" } });
  if (!res.ok) throw new Error(`feed ${resourceId}: HTTP ${res.status}`);
  const xml = await res.text();
  const items = xml.split(/<item[\s>]/).slice(1, 6);
  for (const raw of items) {
    const title = pick(raw, "title"), link = pick(raw, "link"), desc = strip(pick(raw, "description") || pick(raw, "itunes:summary") || "");
    const enclosure = raw.match(/<enclosure[^>]*url="([^"]+)"/)?.[1];
    const guid = pick(raw, "guid") || enclosure || link;
    if (!title || !guid) continue;
    const exists = await one`SELECT id FROM resource_units WHERE resource_id = ${resourceId} AND ref = ${guid}`;
    if (exists) continue;
    // Pre-listening pack from the description: summary FR, key vocab, difficulty
    const pack = await ask<{ summary_fr: string; key_vocab: { fr: string; en: string }[]; clb_level: number }>("TUTOR",
      `Podcast episode "${title}". Description: ${desc.slice(0, 1500)}.
Return {"summary_fr": 2-sentence French summary at CLB 4 level, "key_vocab": 6 items {fr,en} a learner should know before listening, "clb_level": estimated listening CLB (1-12)}.`, { temperature: 0.3 });
    const seqRow = await one`SELECT COALESCE(MAX(seq),0)+1 AS s FROM resource_units WHERE resource_id = ${resourceId}`;
    const ins = await sql`INSERT INTO resource_units (resource_id, seq, title, ref, clb_level, skills, payload)
      VALUES (${resourceId}, ${seqRow?.s ?? 1}, ${title}, ${guid}, ${pack.clb_level ?? 5}, ${["listening"]}, ${json({ url: link, mp3: enclosure, description: desc.slice(0, 2000), summary: pack.summary_fr, key_vocab: pack.key_vocab })}::jsonb)
      RETURNING *`;
    return ins[0];
  }
  return undefined;
}
const pick = (xml: string, tag: string) => { const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)); return m ? m[1].trim() : ""; };
const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Render a unit for an environment. mode: study (text + audio + gate button) | replay (audio only, shadowing) | active (EN lines -> FR). */
export async function sendUnit(chatId: number, unitId: number, env: string, mode: "study" | "replay" | "active" = "study", deliveryId?: number) {
  const u = await getUnit(unitId);
  if (!u) return sendMessage(chatId, `Unit ${unitId} not found.`);
  await sql`UPDATE resource_units SET status = CASE WHEN status = 'unseen' THEN 'scheduled' ELSE status END, last_used = now() WHERE id = ${unitId}`;
  const cb = `unit:check:${unitId}:${deliveryId ?? 0}:${env}`;
  if (u.payload?.dialogue) return sendAssimil(chatId, u, env, mode, cb);
  return sendEpisode(chatId, u, env, cb);
}

async function sendAssimil(chatId: number, u: any, env: string, mode: "study" | "replay" | "active", cb: string) {
  const d: { fr: string; en: string }[] = u.payload.dialogue ?? [];
  const isRevision = !d.length;
  if (mode === "active") {
    await sendMessage(chatId, `🔁 <b>Active wave — Leçon ${u.seq}</b>\nTranslate each line into French, then take the check.\n\n${d.map((l, i) => `${i + 1}. ${esc(l.en)}`).join("\n")}`,
      [[{ text: "🧪 Check me", callback_data: cb }]]);
    return;
  }
  await sendChatAction(chatId, "record_voice");
  if (mode === "replay") {
    if (u.audio_normal) await sendVoiceById(chatId, u.audio_normal, `🔁 Leçon ${u.seq} — ${esc(u.title ?? "")}. Shadow it: speak with the voice, match rhythm and liaison.`);
    else { const mp3 = await speakDialogue(d, "normal"); const id = await sendVoice(chatId, mp3, `🔁 Leçon ${u.seq} — shadow it`); await sql`UPDATE resource_units SET audio_normal = ${id} WHERE id = ${u.id}`; }
    await sendMessage(chatId, "Shadowed it?", [[{ text: "✅ Done", callback_data: "q:next" }]]);   // replay has no check: learner advances the slot
    return;
  }
  if (isRevision) {
    for (const c of splitTelegram(`📖 <b>Révision ${u.seq}</b>\n\n${esc(u.payload.notes ?? "")}`)) await sendMessage(chatId, c);
    await sendMessage(chatId, "Read the revision notes, then:", [[{ text: "🧪 Check me", callback_data: cb }]]);
    return;
  }
  // TEACH → PRACTICE → CHECK (lib/teach.ts). Cards for the lesson are created once, in the background of the teach step.
  const { teach } = await import("./teach.js");
  await teach(chatId, u, env);
  const have = await one`SELECT COUNT(*)::int AS n FROM cards WHERE unit_id = ${u.id}`;
  if (!have?.n) {
    const r = await ask<{ cards: { front: string; back: string; accept: string[]; kind: string; competency_code: string | null }[] }>("EXAMINER",
      `From this lesson (${u.resource_id} ${u.seq}) extract 8-12 flashcards for a beginner: high-frequency chunks, nouns with article, one grammar pattern (tag competency_code). front = EN prompt with disambiguating hint, back = FR, accept = natural variants. Dialogue: ${JSON.stringify(d)}. Notes: ${u.payload.notes ?? ""}. Return {"cards":[...]}`, { temperature: 0.3 });
    await addCards((r.cards ?? []).map((c) => ({ ...c, unit_id: u.id, tags: [u.resource_id] })));
  }
  await kvSet("practice_cb:" + u.id, { cb }, 12 * 60);   // the practice flow needs the check callback (carries delivery id + env)
}

async function sendEpisode(chatId: number, u: any, env: string, cb: string) {
  const p = u.payload ?? {};
  const vocab = (p.key_vocab ?? []).map((v: any) => `• <b>${esc(v.fr)}</b> — ${esc(v.en)}`).join("\n");
  await sendMessage(chatId,
    `🎙 <b>${esc(u.title ?? u.resource_id)}</b>\n${esc(p.mp3 ?? p.url ?? "")}\n\n<i>${esc(p.summary ?? "")}</i>\n\n📚 Before listening:\n${vocab}\n\n<i>Listen ${env === "driving" ? "in the car" : "on patrol"}; the check asks you to recall it in French.</i>`,
    [[{ text: "🧪 Check me", callback_data: cb }]]);
}

export async function sendNotes(chatId: number, unitId: number) {
  const u = await getUnit(unitId);
  if (!u) return;
  const ex = Array.isArray(u.payload.exercises) ? u.payload.exercises.map((e: any, i: number) => `${i + 1}. ${esc(e.fr ?? e)}${e.en ? `\n    <i>${esc(e.en)}</i>` : ""}`).join("\n") : "";
  for (const c of splitTelegram(`📝 <b>Notes — Leçon ${u.seq}</b>\n\n${esc(u.payload.notes ?? "(none)")}\n\n<b>Exercices</b>\n${ex}`)) await sendMessage(chatId, c);
}

/** Start the gate check for a unit (button handler). Retests include previously missed lines. */
export async function startUnitCheck(chatId: number, unitId: number, env: string, deliveryId?: number) {
  const u = await getUnit(unitId);
  if (!u) return;
  const last = await one`SELECT items FROM unit_checks WHERE unit_id = ${unitId} AND NOT passed ORDER BY created_at DESC LIMIT 1`;
  const missed = last ? (last.items as any[]).filter((i) => !i.correct && i.expected).map((i) => i.expected) : [];
  if (await kvGet("check_session")) return sendMessage(chatId, "⏳ Finish the current check first (or /skip).");
  if (await kvGet("check_authoring")) return;                       // double tap
  await kvSet("check_authoring", { unit: unitId }, 2);
  await sendMessage(chatId, "✍️ Writing your check…");
  const { items, check_type } = await authorUnitGate(u, env, missed).finally(() => kvDel("check_authoring"));
  if (!items.length) return sendMessage(chatId, "Couldn't build a check for this unit — try again.");
  await startCheck({ chatId, type: "unit_gate", ref: { table: "resource_units", id: unitId }, title: `Check — ${u.payload?.dialogue ? `Leçon ${u.seq}` : u.title}`, items, env, pass_pct: 80, meta: { check_type, delivery_id: deliveryId } });
}
