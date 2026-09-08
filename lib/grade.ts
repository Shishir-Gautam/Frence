// CLB compliance engine: GRADER role -> submissions (clb_sub, criteria, corrections) -> grammar evidence,
// error patterns, error cards, skill estimate. Handles writing text, speaking audio, and multi-turn interviews.
import { sql, one, json, getLearner, kvGet, kvDel, kvSet, setClb, logActivity, bumpErrorPattern } from "./db.js";
import { ask, validCode, competencyName } from "./coach.js";
import { recordEvidence } from "./grammar.js";
import { addCards } from "./srs.js";
import { sendMessage, esc } from "./telegram.js";
import { splitTelegram } from "./text.js";
import { localDate } from "./time.js";

export type Grade = {
  task_type: string; clb_sub: number; score_20: number;
  criteria: Record<string, number | null>;
  transcript?: string | null; corrected_text: string;
  corrections: { original: string; fix: string; why: string; competency_code: string | null; error_type: string }[];
  grammar_evidence: { competency_code: string; correct: boolean; excerpt?: string }[];
  new_cards: { front: string; back: string; accept?: string[]; kind?: string; competency_code?: string | null }[];
  strengths: string[]; next_focus: string[]; feedback_en: string;
  module_fail_signals?: string[];
};

/** When a module ordered this task, the grader is also asked which of THAT module's failure modes it sees. */
async function moduleClause(submissionId: number): Promise<string> {
  const { kvGet } = await import("./db.js");
  const run = await kvGet<any>("module_run");
  if (!run || (run.submission_id && run.submission_id !== submissionId)) return "";
  const { taskDef } = await import("./task-modules.js");
  const def = taskDef(run.module_id);
  if (!def) return "";
  return `\n\nThis task was ordered by MODULE ${def.id} — ${def.name}. Objective: ${def.can_do}
Grade it as evidence for that objective specifically. Also return "module_fail_signals": the subset of this list you actually observe (exact strings, [] if none): ${JSON.stringify(def.fail_signals)}`;
}


async function pendingSubmission(skill: "writing" | "speaking", awaiting: any) {
  if (awaiting?.submission_id) return one`SELECT * FROM submissions WHERE id = ${awaiting.submission_id}`;
  return one`SELECT * FROM submissions WHERE skill = ${skill}::skill AND graded_at IS NULL AND created_at > now() - interval '12 hours' ORDER BY created_at DESC LIMIT 1`;
}

export async function gradeWriting(chatId: number, text: string) {
  const awaiting = await kvGet<any>("awaiting");
  let sub = await pendingSubmission("writing", awaiting?.kind === "writing" ? awaiting : null);
  if (!sub) { const r = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('writing','free','seated','(free writing)') RETURNING *`; sub = r[0]; }
  await sendMessage(chatId, "📝 Grading against the TCF rubric…");
  const g = await ask<Grade>("GRADER", `Task type: ${sub.task_type}\nPrompt:\n${sub.prompt}\n\nLearner's text (${text.split(/\s+/).length} words):\n${text}${await moduleClause(Number(sub.id))}`, { temperature: 0.2 });
  await finish(chatId, "writing", sub, g, { content: text, word_count: text.split(/\s+/).length, delivery_id: awaiting?.delivery_id });
}

export async function gradeSpeaking(chatId: number, audio: Uint8Array, mime: string, fileId: string, durationS?: number) {
  const interview = await kvGet<any>("interview_session");
  if (interview) return interviewTurn(chatId, audio, mime, interview);
  const awaiting = await kvGet<any>("awaiting");
  let sub = await pendingSubmission("speaking", awaiting?.kind === "speaking" ? awaiting : null);
  if (!sub) { const r = await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('speaking','free','seated','(free speaking)') RETURNING *`; sub = r[0]; }
  await sendMessage(chatId, "🎧 Listening… transcribing and grading.");
  const g = await ask<Grade>("GRADER", `Task type: ${sub.task_type}\nPrompt:\n${sub.prompt}\n\nGrade the attached French audio (${durationS ?? "?"} s). Transcribe first.${await moduleClause(Number(sub.id))}`, { audio: { data: audio, mime }, temperature: 0.2 });
  await finish(chatId, "speaking", sub, g, { content: g.transcript ?? "", audio_file: fileId, duration_s: durationS, delivery_id: awaiting?.delivery_id });
}

/** Interview: transcribe the turn, ask a follow-up, or grade the whole exchange after max_turns. */
async function interviewTurn(chatId: number, audio: Uint8Array, mime: string, st: any) {
  const t = await ask<{ transcript: string; follow_up_fr: string; done: boolean }>("EXAMINER",
    `You are the TCF examiner mid-interview. Exchange so far: ${JSON.stringify(st.turns)}. Transcribe the learner's answer exactly (keep errors). Then, unless this was turn ${st.max_turns}, ask ONE natural follow-up question in French that pushes for more detail, a justification, or a past/future form. Return {"transcript","follow_up_fr","done":bool}`,
    { audio: { data: audio, mime }, temperature: 0.5 });
  st.turns.push({ role: "learner", text: String(t.transcript ?? "") });
  const learnerTurns = st.turns.filter((x: any) => x.role === "learner").length;
  if (learnerTurns >= st.max_turns || t.done) return finishInterview(chatId, st);
  st.turns.push({ role: "examiner", text: String(t.follow_up_fr ?? "Continuez.") });
  await kvSet("interview_session", st, 60);
  await sendMessage(chatId, `<i>${esc(String(t.transcript ?? ""))}</i>\n\n🧑‍⚖️ ${esc(String(t.follow_up_fr ?? "Continuez."))}`, [[{ text: "⏹ End interview", callback_data: "interview:end" }]]);
}
export async function finishInterview(chatId: number, st?: any) {
  st = st ?? (await kvGet<any>("interview_session"));
  if (!st) return;
  await kvDel("interview_session");
  const sub = await one`SELECT * FROM submissions WHERE id = ${st.submission_id}`;
  if (!sub) return;
  if (!st.turns.some((x: any) => x.role === "learner")) { await sendMessage(chatId, "Interview ended with no answers — nothing graded."); const { onItemDone } = await import("./deliver.js"); return onItemDone("interview"); }
  const transcript = st.turns.map((x: any) => `${x.role === "examiner" ? "EXAMINATEUR" : "CANDIDAT"}: ${x.text}`).join("\n");
  await sendMessage(chatId, "🧑‍⚖️ Interview over — grading the whole exchange.");
  const g = await ask<Grade>("GRADER", `Task type: ${sub.task_type} (multi-turn interview; grade ONLY the CANDIDAT lines, as one speaking performance).\nTopic: ${sub.prompt}\n\n${transcript}`, { temperature: 0.2 });
  await finish(chatId, "speaking", sub, g, { content: transcript, delivery_id: st.delivery_id });
}

async function finish(chatId: number, skill: "writing" | "speaking", sub: any, g: Grade, extra: { content: string; word_count?: number; audio_file?: string; duration_s?: number; delivery_id?: number }) {
  const clb = Math.max(1, Math.min(12, Number(g.clb_sub) || 1));
  await sql`UPDATE submissions SET content=${extra.content}, word_count=${extra.word_count ?? null}, audio_file=${extra.audio_file ?? null}, duration_s=${extra.duration_s ?? null},
            score_20=${g.score_20 ?? null}, clb_sub=${clb}, criteria=${json(g.criteria ?? {})}::jsonb, corrections=${json(g.corrections ?? [])}::jsonb,
            feedback=${json({ strengths: g.strengths, next_focus: g.next_focus, feedback_en: g.feedback_en, corrected_text: g.corrected_text })}::jsonb, graded_at=now() WHERE id=${sub.id}`;
  // evidence (correct AND incorrect uses), weight 1.0 for free production
  const ev = (g.grammar_evidence ?? []).filter((e) => validCode(e.competency_code)).map((e) => ({ ...e, weight: 1.0 }));
  for (const c of (g.corrections ?? []).filter((c) => c && c.original)) {
    const code = validCode(c.competency_code);
    if (code && !ev.some((e) => e.competency_code === code && e.excerpt === c.original)) ev.push({ competency_code: code, correct: false, weight: 1.0, excerpt: c.original, correction: c.fix } as any);
    if (!code && c.error_type && c.error_type !== "grammar") await bumpErrorPattern(String(c.why ?? c.error_type).slice(0, 60), String(c.error_type), `${c.original} → ${c.fix}`);
  }
  await recordEvidence("submission", sub.id, ev);
  // exam evidence: a tcf_* task or a full interview is TCF-shaped; a micro/free task is not
  const { recordExam } = await import("./nclc.js");
  await recordExam({ component: skill, source: "submission", source_id: sub.id, item_clb: clb,
                     exam_format: /^(tcf_|interview)/.test(String(sub.task_type)) });
  const added = await addCards((g.new_cards ?? []).slice(0, 6).map((c) => ({ ...c, kind: c.kind ?? "error", tags: [skill, "error"] })));
  const learner = await getLearner();
  await logActivity(localDate(learner.tz), "seated", skill, skill === "writing" ? 15 : 8, true, { table: "submissions", id: sub.id });
  const aw = await kvGet<any>("awaiting");
  if (aw?.kind === skill || aw?.submission_id === sub.id) await kvDel("awaiting");
  await updateProductiveEstimate(skill);
  // exam-track attribution: the graded CLB advances (or costs back) the task module's counters
  const { attributeToModule } = await import("./module-run.js");
  const moved = await attributeToModule(null, clb, { submission_id: Number(sub.id), fail_signals: g.module_fail_signals ?? [], ref: { table: "submissions", id: Number(sub.id) } });

  const crit = Object.entries(g.criteria ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ");
  const corr = (g.corrections ?? []).filter((c) => c && c.original && c.fix).slice(0, 8).map((c) => `• <s>${esc(c.original)}</s> → <b>${esc(c.fix)}</b>\n  <i>${esc(c.why ?? "")}${c.competency_code ? ` [${esc(competencyName(c.competency_code))}]` : ""}</i>`).join("\n");
  const msg = `📊 <b>${skill === "writing" ? "Écrit" : "Oral"} — CLB ${clb} · ${g.score_20 ?? "–"}/20</b>\n<i>${esc(crit)}</i>\n\n` +
    (g.transcript && skill === "speaking" && sub.task_type?.startsWith("interview") !== true ? `🗣 <i>${esc(g.transcript)}</i>\n\n` : "") +
    `✅ <b>Version corrigée</b>\n${esc(g.corrected_text ?? "")}\n\n${corr ? `🔧 <b>Corrections</b>\n${corr}\n\n` : ""}` +
    `💪 ${esc((g.strengths ?? []).join("; "))}\n🎯 ${esc((g.next_focus ?? []).map(competencyName).join("; "))}\n\n${esc(g.feedback_en ?? "")}` +
    (added ? `\n\n🃏 ${added} cards from your mistakes.` : "") +
    (moved ? `\n🧩 ${moved.to === moved.from ? `Module evidence recorded (${moved.to}).` : `Module ${moved.from} → <b>${moved.to}</b>.`}` : "");
  for (const chunk of splitTelegram(msg)) await sendMessage(chatId, chunk);
  const { onItemDone } = await import("./deliver.js");
  await onItemDone(String(sub.task_type).startsWith("interview") ? "interview" : skill);
}

/** Productive skill estimate: recency-weighted mean of the last 6 clb_sub, confidence from count & spread. */
export async function updateProductiveEstimate(skill: "writing" | "speaking") {
  const rows = await sql`SELECT clb_sub, task_type FROM submissions WHERE skill = ${skill}::skill AND graded_at IS NOT NULL ORDER BY graded_at DESC LIMIT 6`;
  if (!rows.length) return;
  const w = [0.3, 0.22, 0.18, 0.12, 0.1, 0.08];
  let s = 0, ws = 0; rows.forEach((r, i) => { s += Number(r.clb_sub) * w[i]; ws += w[i]; });
  const est = Math.round((s / ws) * 100) / 100;
  const tcf = rows.filter((r) => String(r.task_type).startsWith("tcf") || String(r.task_type).startsWith("interview")).length;
  const confidence = Math.min(1, 0.3 + rows.length * 0.08 + tcf * 0.05);
  await setClb(skill, est, confidence, { n: rows.length, tcf_tasks: tcf });
}

/** Receptive estimate from quiz accuracy by item CLB: highest level with ≥70% on ≥4 items in 21 days. */
export async function updateReceptiveEstimates() {
  for (const skill of ["listening", "reading"] as const) {
    const rows = await sql`SELECT ROUND(item_clb)::int AS clb, COUNT(*)::int n, AVG(CASE WHEN correct THEN 1 ELSE 0 END)::float acc
      FROM quiz_results WHERE skill = ${skill}::skill AND created_at >= now() - interval '21 days' GROUP BY 1 ORDER BY 1`;
    if (!rows.length) continue;
    let est = 0, total = 0;
    for (const r of rows) { total += r.n; if (r.n >= 4 && r.acc >= 0.7) est = Math.max(est, r.clb + (r.acc >= 0.9 ? 0.5 : 0)); }
    if (est === 0) est = Math.max(1, Math.min(...rows.map((r) => r.clb)) - 0.5);
    await setClb(skill, est, Math.min(1, total / 40), { rows });
  }
}
