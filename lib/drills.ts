// Driving drills: DRILL AUTHOR writes a prompt→pause→answer script for target competencies + due cards,
// tts.renderDrill assembles one MP3, the post-drive spot check turns it into evidence.
import { sql, one, json, getLearner, currentClb } from "./db.js";
import { sendMessage, sendVoice, sendVoiceById, sendChatAction, esc } from "./telegram.js";
import { ask, competencyName, COMPETENCIES } from "./coach.js";
import { renderDrill, type DrillStep } from "./tts.js";
import { startCheck, sanitize, type Item } from "./checks.js";

export type DrillSpec = { method: "pimsleur" | "michel_thomas" | "language_transfer"; competency_codes: string[]; minutes?: number };

export async function authorDrill(spec: DrillSpec) {
  const learner = await getLearner();
  const clb = await currentClb();
  const level = Math.max(1, Math.round((clb.speaking.clb + clb.listening.clb) / 2));
  const cards = await sql`SELECT id, front, back FROM cards WHERE NOT suspended AND state <> 'new' AND due <= now() + interval '1 day' ORDER BY due LIMIT 12`;
  const comps = spec.competency_codes.map((c) => COMPETENCIES.find((x) => x.code === c)).filter(Boolean);
  const mastery = await sql`SELECT competency_code, mastery_pct FROM grammar_mastery WHERE competency_code = ANY(${spec.competency_codes})`;
  const target = spec.minutes ?? 18;
  const r = await ask<{ title: string; script: DrillStep[]; spot_check: Item[] }>("DRILL AUTHOR",
    `Method: ${spec.method}. Learner level ≈ CLB ${level}. Target ${target} minutes of audio (≈ ${Math.round(target * 1.4)} prompt/answer pairs including recaps).
Target competencies: ${JSON.stringify(comps.map((c) => ({ code: c!.code, name: c!.name, description: c!.description, mastery: mastery.find((m) => m.competency_code === c!.code)?.mastery_pct ?? 0 })))}.
Due FSRS cards to recycle inside the drill (use at least 8, weave them into the target structures): ${JSON.stringify(cards.map((c) => ({ id: c.id, en: c.front, fr: c.back })))}.
Pause after each prompt: ${learner.settings?.drill_pause_seconds ?? 4} s (set pause_s per prompt: longer for longer sentences).
Return {"title","script":[{"type":"teach|prompt|answer|recap","en","fr","pause_s"}],"spot_check":[5 items {"kind":"typed","prompt":EN,"expected":FR,"accept":[],"competency_code"}]}. Every prompt must be immediately followed by its answer step.`,
    { temperature: 0.5 });
  const script = (r.script ?? []).filter((s) => s && ["teach", "prompt", "answer", "recap", "pause"].includes(s.type));
  if (script.filter((s) => s.type === "prompt").length < 6) throw new Error("drill script too short");
  const ins = await sql`INSERT INTO drills (method, title, competency_codes, vocab_card_ids, clb_level, script)
    VALUES (${spec.method}, ${r.title ?? "Drill"}, ${spec.competency_codes}, ${cards.map((c) => Number(c.id))}, ${level}, ${json(script)}::jsonb) RETURNING id`;
  const id = Number(ins[0].id);
  await sql`INSERT INTO kv (k, v, updated_at) VALUES (${"drill_spot:" + id}, ${json(sanitize(r.spot_check ?? []))}::jsonb, now()) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`;
  return id;
}

/** Render (or reuse) and send the drill as a voice note; then arm the spot check. */
export async function sendDrill(chatId: number, drillId: number, deliveryId?: number) {
  const d = await one`SELECT * FROM drills WHERE id = ${drillId}`;
  if (!d) return sendMessage(chatId, "Drill not found.");
  const caption = `🚗 <b>${esc(d.title)}</b> · ${d.method.replace("_", " ")} · ${d.competency_codes.map(competencyName).map(esc).join(", ")}\n<i>Say each answer out loud in the pause. Spot check after the drive.</i>`;
  if (d.audio_file) await sendVoiceById(chatId, d.audio_file, caption);
  else {
    await sendChatAction(chatId, "record_voice");
    const { mp3, seconds } = await renderDrill(d.script, (await getLearner()).settings?.drill_pause_seconds ?? 4);
    const fileId = await sendVoice(chatId, mp3, caption, undefined, `drill-${drillId}.mp3`);
    await sql`UPDATE drills SET audio_file = ${fileId}, duration_s = ${seconds} WHERE id = ${drillId}`;
  }
  await sql`UPDATE drills SET times_played = times_played + 1 WHERE id = ${drillId}`;
  await sendMessage(chatId, "After the drive:", [[{ text: "🧪 Spot check (5)", callback_data: `drill:spot:${drillId}${deliveryId ? ":" + deliveryId : ""}` }]]);
}

export async function startSpotCheck(chatId: number, drillId: number, deliveryId?: number) {
  const d = await one`SELECT title FROM drills WHERE id = ${drillId}`;
  const kv = await one`SELECT v FROM kv WHERE k = ${"drill_spot:" + drillId}`;
  const items: Item[] = kv?.v ?? [];
  if (!items.length) return sendMessage(chatId, "No spot check stored for this drill.");
  await startCheck({ chatId, type: "drill_spot", ref: { table: "drills", id: drillId }, title: `Spot check — ${d?.title ?? "drill"}`, items, env: "micro", pass_pct: 80, meta: { delivery_id: deliveryId } });
}
