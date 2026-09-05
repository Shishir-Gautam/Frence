// Resource router runtime: materialise units (Assimil lessons, podcast/news episodes), render them for an
// environment, and hand off to the gate check. A unit only advances through unit_checks.
import { sql, one, json, getLearner } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc, type Keyboard } from "./telegram.js";
import { speakDialogue } from "./tts.js";
import { ask } from "./coach.js";
import { addCards } from "./srs.js";
import { startCheck, authorUnitGate } from "./checks.js";
import { splitTelegram } from "./text.js";

export async function getUnit(id: number) { return one`SELECT * FROM resource_units WHERE id = ${id}`; }

/** Next unit for a resource: attempted (retest) first, then scheduled/unseen in order. For feeds, fetch a new episode. */
export async function nextUnit(resourceId: string) {
  const u = await one`SELECT * FROM resource_units WHERE resource_id = ${resourceId} AND status IN ('attempted','scheduled','unseen')
                       ORDER BY (status = 'attempted') DESC, seq NULLS LAST, id LIMIT 1`;
  if (u) return u;
  const r = await one`SELECT * FROM resources WHERE id = ${resourceId}`;
  if (r?.feed_url) return ingestLatestEpisode(resourceId, r.feed_url);
  return undefined;
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
export async function sendUnit(chatId: number, unitId: number, env: string, mode: "study" | "replay" | "active" = "study") {
  const u = await getUnit(unitId);
  if (!u) return sendMessage(chatId, `Unit ${unitId} not found.`);
  await sql`UPDATE resource_units SET status = CASE WHEN status = 'unseen' THEN 'scheduled' ELSE status END, last_used = now() WHERE id = ${unitId}`;
  if (u.resource_id === "assimil") return sendAssimil(chatId, u, env, mode);
  return sendEpisode(chatId, u, env);
}

async function sendAssimil(chatId: number, u: any, env: string, mode: "study" | "replay" | "active") {
  const d: { fr: string; en: string }[] = u.payload.dialogue ?? [];
  const isRevision = !d.length;
  if (mode === "active") {
    await sendMessage(chatId, `🔁 <b>Active wave — Leçon ${u.seq}</b>\nTranslate each line into French, then take the check.\n\n${d.map((l, i) => `${i + 1}. ${esc(l.en)}`).join("\n")}`,
      [[{ text: "🧪 Check me", callback_data: `unit:check:${u.id}` }]]);
    return;
  }
  await sendChatAction(chatId, "record_voice");
  if (mode === "replay") {
    if (u.audio_normal) await sendVoiceById(chatId, u.audio_normal, `🔁 Leçon ${u.seq} — ${esc(u.title ?? "")}. Shadow it: speak with the voice, match rhythm and liaison.`);
    else { const mp3 = await speakDialogue(d, "normal"); const id = await sendVoice(chatId, mp3, `🔁 Leçon ${u.seq} — shadow it`); await sql`UPDATE resource_units SET audio_normal = ${id} WHERE id = ${u.id}`; }
    return;
  }
  const header = `📖 <b>Assimil ${u.seq} — ${esc(u.title ?? "")}</b>${isRevision ? "\n<i>Révision</i>" : `\n<i>${env === "patrol" ? "Listen ×2 while walking, read along, repeat aloud." : "Listen, read, repeat."} Then tap Check.</i>`}`;
  const body = isRevision ? esc(u.payload.notes ?? "") : d.map((l, i) => `${i + 1}. ${esc(l.fr)}\n    <i>${esc(l.en)}</i>`).join("\n");
  const chunks = splitTelegram(`${header}\n\n${body}`);
  for (let i = 0; i < chunks.length; i++) await sendMessage(chatId, chunks[i], i === chunks.length - 1 && !isRevision ? undefined : undefined);
  if (!isRevision) {
    if (u.audio_slow) await sendVoiceById(chatId, u.audio_slow, `🐢 Leçon ${u.seq} — lent`);
    else { const mp3 = await speakDialogue(d, "slow"); const id = await sendVoice(chatId, mp3, `🐢 Leçon ${u.seq} — lent`); await sql`UPDATE resource_units SET audio_slow = ${id} WHERE id = ${u.id}`; }
    if (u.audio_normal) await sendVoiceById(chatId, u.audio_normal, `🐇 Leçon ${u.seq} — naturel`);
    else { const mp3 = await speakDialogue(d, "normal"); const id = await sendVoice(chatId, mp3, `🐇 Leçon ${u.seq} — naturel`); await sql`UPDATE resource_units SET audio_normal = ${id} WHERE id = ${u.id}`; }
    // cards from the lesson, once
    const have = await one`SELECT COUNT(*)::int AS n FROM cards WHERE unit_id = ${u.id}`;
    if (!have?.n) {
      const r = await ask<{ cards: { front: string; back: string; accept: string[]; kind: string; competency_code: string | null }[] }>("EXAMINER",
        `From Assimil lesson ${u.seq} extract 8-12 flashcards for a beginner: high-frequency chunks, nouns with article, one grammar pattern (tag competency_code). front = EN prompt with disambiguating hint, back = FR, accept = natural variants. Dialogue: ${JSON.stringify(d)}. Notes: ${u.payload.notes ?? ""}. Return {"cards":[...]}`, { temperature: 0.3 });
      const n = await addCards((r.cards ?? []).map((c) => ({ ...c, unit_id: u.id, tags: ["assimil"] })));
      if (n) await sendMessage(chatId, `🃏 ${n} cards from this lesson added.`);
    }
  }
  const kb: Keyboard = [[{ text: "🧪 Check me (5 items)", callback_data: `unit:check:${u.id}` }], [{ text: "📝 Notes & exercises", callback_data: `unit:notes:${u.id}` }]];
  await sendMessage(chatId, isRevision ? "Read the revision notes, then:" : "When you've listened twice:", isRevision ? [[{ text: "🧪 Check me", callback_data: `unit:check:${u.id}` }]] : kb);
}

async function sendEpisode(chatId: number, u: any, env: string) {
  const p = u.payload ?? {};
  const vocab = (p.key_vocab ?? []).map((v: any) => `• <b>${esc(v.fr)}</b> — ${esc(v.en)}`).join("\n");
  await sendMessage(chatId,
    `🎙 <b>${esc(u.title ?? u.resource_id)}</b>\n${p.mp3 ?? p.url ?? ""}\n\n<i>${esc(p.summary ?? "")}</i>\n\n📚 Before listening:\n${vocab}\n\n<i>Listen ${env === "driving" ? "in the car" : "on patrol"}; the check asks you to recall it in French.</i>`,
    [[{ text: "🧪 Check me", callback_data: `unit:check:${u.id}` }]]);
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
  await sendMessage(chatId, "✍️ Writing your check…");
  const { items, check_type } = await authorUnitGate(u, env, missed);
  if (!items.length) return sendMessage(chatId, "Couldn't build a check for this unit — try again.");
  await startCheck({ chatId, type: "unit_gate", ref: { table: "resource_units", id: unitId }, title: `Check — ${u.resource_id === "assimil" ? `Leçon ${u.seq}` : u.title}`, items, env, pass_pct: 80, meta: { check_type, delivery_id: deliveryId } });
}
