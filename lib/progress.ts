import { sql, one, getLearner, currentClb, setClb } from "./db.js";
import { sendMessage, esc } from "./telegram.js";
import { tutor, ask } from "./coach.js";
import { gridSummary } from "./grammar.js";
import { srsStats } from "./srs.js";
import { updateReceptiveEstimates } from "./grade.js";
import type { Item } from "./checks.js";
import { stage } from "./stage.js";

const bar = (v: number, max = 7) => { const n = Math.round((Math.min(v, max) / max) * 10); return "█".repeat(n) + "░".repeat(10 - n); };
export const expectedClb = (days: number) => Math.min(7, +(7 * Math.min(1, days / 240)).toFixed(1));

export async function sendProgress(chatId: number) {
  await updateReceptiveEstimates();
  const learner = await getLearner();
  const clb = await currentClb();
  const days = Math.max(0, Math.floor((Date.now() - new Date(learner.start_date).getTime()) / 86400000));
  const skills = ["listening", "reading", "writing", "speaking"] as const;
  const lines = skills.map((s) => `${s.padEnd(9)} ${bar(clb[s].clb)} ${clb[s].clb.toFixed(1)}${clb[s].confidence < 0.4 ? " ?" : ""}`).join("\n");
  const grid = await gridSummary();
  const srs = await srsStats();
  const t = await one`SELECT COALESCE(SUM(minutes),0)::int AS total, COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS verified FROM activity_log`;
  const w = await one`SELECT COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS v FROM activity_log WHERE log_date >= CURRENT_DATE - 6`;
  const units = await sql`SELECT resource_id, COUNT(*) FILTER (WHERE status IN ('passed','mastered'))::int AS passed, COUNT(*) FILTER (WHERE status = 'attempted')::int AS retest FROM resource_units GROUP BY resource_id`;
  const streak = await streakDays();
  const fam = grid.by_family.map((f: any) => `${f.family} ${f.mastery}% (${f.solid}/${f.n})`).join(" · ");
  const weakest = grid.weakest.map((x: any) => `${esc(x.name)} ${Math.round(x.mastery_pct)}%`).join("\n   ");
  if ((await stage()) === "beginner") {
    const lessons = await sql`SELECT resource_id, seq, title, status, best_score FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status <> 'unseen' ORDER BY seq`;
    const done = lessons.filter((x) => ["passed", "mastered"].includes(x.status)).length;
    const seen = await one`SELECT COUNT(*)::int AS n FROM grammar_mastery WHERE evidence_count > 0`;
    return sendMessage(chatId,
      `🌱 <b>Beginner track</b> (day ${days}) — ${done} lesson${done === 1 ? "" : "s"} passed\n` +
      lessons.slice(-8).map((x) => `${["passed", "mastered"].includes(x.status) ? "✅" : x.status === "attempted" ? "🔁" : "▫️"} ${x.seq}. ${esc(x.title ?? "")}${x.best_score ? ` (${Math.round(Number(x.best_score))}%)` : ""}`).join("\n") +
      `\n\n⏱ ${Math.round((t?.verified ?? 0) / 60)} h verified · ${w?.v ?? 0} min last 7d · 🔥 ${streak}d\n🃏 ${srs.total} cards · ${srs.due_now} due · retention ${(Number(srs.retention_14d) * 100).toFixed(0)}%\n📐 grammar points with evidence: ${seen?.n ?? 0}/44\n\n<i>The exam-style dashboard (CLB per skill, grid) switches on once you've passed ~8 lessons and listening reaches CLB 3.</i>`);
  }
  await sendMessage(chatId,
    `📈 <b>Progress → CLB ${learner.target_clb}</b> (day ${days}, target now ${expectedClb(days)})${learner.placement_done ? "" : "\n⚠️ Run /placement first — estimates are placeholders."}\n<pre>${esc(lines)}</pre>` +
    `⏱ ${Math.round((t?.verified ?? 0) / 60)} h verified / ${Math.round((t?.total ?? 0) / 60)} h logged · ${w?.v ?? 0} verified min last 7d · 🔥 ${streak}d\n` +
    `🃏 ${srs.total} cards · ${srs.due_now} due · retention ${(Number(srs.retention_14d) * 100).toFixed(0)}% (${srs.reviews_14d} reviews)\n` +
    `📚 ${units.map((u) => `${u.resource_id}: ${u.passed} passed${u.retest ? `, ${u.retest} to retest` : ""}`).join(" · ") || "no units yet"}\n\n` +
    `📐 <b>Grammar grid</b>\n${esc(fam)}\n🎯 Weakest that matter:\n   ${weakest}`);
}

async function streakDays() {
  const days = await sql`SELECT DISTINCT log_date::text AS d FROM activity_log WHERE verified AND log_date >= CURRENT_DATE - 120`;
  const set = new Set(days.map((r) => r.d));
  let n = 0;
  for (let i = 0; i < 120; i++) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); if (set.has(d)) n++; else if (i > 0) break; }
  return n;
}

export async function sendWeeklyReport(chatId: number) {
  await updateReceptiveEstimates();
  const learner = await getLearner();
  if ((await stage()) === "beginner") {   // no exam talk yet: lessons, checks, cards
    const wk = await sql`SELECT COUNT(*) FILTER (WHERE passed)::int AS passed, COUNT(*)::int AS checks, ROUND(AVG(score_pct))::int AS avg FROM unit_checks WHERE created_at >= now() - interval '7 days'`;
    const mins = await one`SELECT COALESCE(SUM(minutes) FILTER (WHERE verified),0)::int AS v FROM activity_log WHERE log_date >= CURRENT_DATE - 6`;
    const srs = await srsStats();
    const drills = await one`SELECT COUNT(*)::int AS n, ROUND(AVG(score_pct))::int AS avg FROM drill_sessions WHERE played_at >= now() - interval '7 days'`;
    await sendMessage(chatId, `🗓 <b>This week</b>\n✅ ${wk[0]?.passed ?? 0} lesson checks passed of ${wk[0]?.checks ?? 0} (avg ${wk[0]?.avg ?? 0}%)\n🚗 ${drills?.n ?? 0} drive spot checks (avg ${drills?.avg ?? 0}%)\n🃏 ${srs.reviews_14d} card reviews · retention ${(Number(srs.retention_14d) * 100).toFixed(0)}%\n⏱ ${mins?.v ?? 0} verified minutes\n\n<i>One lesson a day, every day, is the whole strategy right now. The exam dashboard starts after ~8 lessons.</i>`);
    return sendProgress(chatId);
  }
  const days = Math.floor((Date.now() - new Date(learner.start_date).getTime()) / 86400000);
  const data = {
    clb: await currentClb(), expected: expectedClb(days), grid: await gridSummary(), srs: await srsStats(),
    week: await sql`SELECT environment, SUM(minutes) FILTER (WHERE verified)::int AS verified, SUM(minutes)::int AS logged FROM activity_log WHERE log_date >= CURRENT_DATE - 6 GROUP BY 1`,
    submissions: await sql`SELECT skill, task_type, clb_sub, graded_at::date AS d FROM submissions WHERE graded_at >= now() - interval '7 days' ORDER BY graded_at`,
    checks: await sql`SELECT check_type, score_pct, passed FROM unit_checks WHERE created_at >= now() - interval '7 days'`,
    drills: await sql`SELECT score_pct FROM drill_sessions WHERE played_at >= now() - interval '7 days'`,
    trend: await sql`SELECT skill, clb, computed_at::date AS d FROM skill_estimates WHERE computed_at >= now() - interval '28 days' ORDER BY computed_at`,
  };
  const txt = await tutor(`Write the weekly coaching review (≤220 words, plain text). What improved (numbers), what lagged, on track for CLB 7 in all four skills? (expected now ${data.expected}), the single biggest lever next week, one honest sentence about risk. Data: ${JSON.stringify(data)}`);
  await sendMessage(chatId, `🗓 <b>Weekly review</b>\n\n${esc(txt)}`);
  await sendProgress(chatId);
}

/** After the placement test: set initial CLB estimates from item results. */
export async function placementEstimate(items: Item[]): Promise<string> {
  const r = await ask<{ listening: number; reading: number; writing: number; speaking: number; note: string }>("EXAMINER",
    `Placement results: ${JSON.stringify(items.map((i) => ({ kind: i.kind, item_clb: i.item_clb, skill: i.skill, competency_code: i.competency_code, correct: i.correct, given: i.given, expected: i.expected })))}.
Estimate starting CLB (1-12, decimals allowed, be conservative) per skill. Return {"listening","reading","writing","speaking","note": one sentence}`, { temperature: 0.1 });
  for (const s of ["listening", "reading", "writing", "speaking"] as const) await setClb(s, Math.max(1, Math.min(12, Number((r as any)[s]) || 1)), 0.35, { placement: true });
  return `Placement: L ${r.listening} · R ${r.reading} · W ${r.writing} · S ${r.speaking}. ${r.note}`;
}
