// Grammar mastery grid: record evidence, recompute mastery, expose weakest / teachable competencies.
import { sql, one, json } from "./db.js";
import { validCode } from "./coach.js";

export type Evidence = { competency_code: string; correct: boolean; weight?: number; excerpt?: string; correction?: string };

/**
 * Record evidence from any source and recompute mastery for the touched competencies.
 * Mastery = recency-weighted, weight-weighted accuracy over the last 40 observations,
 * shrunk toward 50% when evidence is thin, and decayed 1%/day without evidence after 10 days.
 */
export async function recordEvidence(sourceType: string, sourceId: number | null, items: Evidence[]) {
  const touched = new Set<string>();
  for (const e of items) {
    const code = validCode(e.competency_code);
    if (!code) continue;
    await sql`INSERT INTO grammar_evidence (competency_code, source_type, source_id, correct, weight, excerpt, correction)
              VALUES (${code}, ${sourceType}, ${sourceId}, ${e.correct}, ${e.weight ?? 1}, ${e.excerpt ?? null}, ${e.correction ?? null})`;
    touched.add(code);
  }
  for (const code of touched) await recompute(code);
  return touched.size;
}

export async function recompute(code: string) {
  const rows = await sql`SELECT correct, weight, created_at FROM grammar_evidence WHERE competency_code = ${code} ORDER BY created_at DESC LIMIT 40`;
  if (!rows.length) return;
  const now = Date.now();
  let num = 0, den = 0;
  rows.forEach((r, i) => {
    const ageDays = (now - new Date(r.created_at).getTime()) / 86400000;
    const w = Number(r.weight) * Math.exp(-i / 12) * Math.exp(-ageDays / 45);   // recency by rank and by age
    num += (r.correct ? 1 : 0) * w; den += w;
  });
  const n = rows.length;
  const raw = den ? num / den : 0.5;
  const shrink = n / (n + 4);                       // thin evidence -> toward 50%
  const mastery = Math.round((raw * shrink + 0.5 * (1 - shrink)) * 1000) / 10;
  const confidence = Math.min(1, Math.round((n / 15) * 100) / 100);
  let streak = 0; for (const r of rows) { if (r.correct) streak++; else break; }
  const prev = await one`SELECT mastery_pct, status FROM grammar_mastery WHERE competency_code = ${code}`;
  const prevPct = prev ? Number(prev.mastery_pct) : 0;
  const status =
    mastery >= 85 && confidence >= 0.6 ? "mastered" :
    mastery >= 70 && confidence >= 0.4 ? "reliable" :
    prevPct - mastery >= 15 && prevPct >= 70 ? "regressed" :
    n >= 3 ? "practising" : "introduced";
  await sql`INSERT INTO grammar_mastery (competency_code, mastery_pct, confidence, evidence_count, correct_streak, last_evidence, status, updated_at)
            VALUES (${code}, ${mastery}, ${confidence}, ${n}, ${streak}, now(), ${status}, now())
            ON CONFLICT (competency_code) DO UPDATE SET mastery_pct = EXCLUDED.mastery_pct, confidence = EXCLUDED.confidence,
              evidence_count = EXCLUDED.evidence_count, correct_streak = EXCLUDED.correct_streak, last_evidence = now(), status = EXCLUDED.status, updated_at = now()`;
}

/** Nightly: decay competencies with no evidence for >10 days (1%/day), flag regressions. */
export async function decayAll() {
  await sql`UPDATE grammar_mastery SET mastery_pct = GREATEST(0, mastery_pct - 1), updated_at = now()
            WHERE last_evidence < now() - interval '10 days' AND mastery_pct > 0`;
  await sql`UPDATE grammar_mastery SET status = 'regressed' WHERE status IN ('reliable','mastered') AND mastery_pct < 65`;
}

export async function markTaught(code: string) {
  await sql`UPDATE grammar_mastery SET last_taught = now(), status = CASE WHEN status = 'untouched' THEN 'introduced' ELSE status END WHERE competency_code = ${code}`;
}

/** Competencies the planner may teach next: weakest by priority whose prerequisites are ≥60% mastered (or have no prerequisites). */
export async function teachable(limit = 5) {
  return sql`
    SELECT w.code, w.name, w.family, w.clb_needed, w.exam_weight, w.mastery_pct, w.confidence, w.status, w.priority::numeric(6,2) AS priority
    FROM v_grammar_weakest w JOIN grammar_competencies c ON c.code = w.code
    WHERE w.status <> 'mastered'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(c.prerequisites) p LEFT JOIN grammar_mastery pm ON pm.competency_code = p
        WHERE COALESCE(pm.mastery_pct, 0) < 60)
    ORDER BY w.priority DESC LIMIT ${limit}`;
}

export async function gridSummary() {
  const rows = await sql`SELECT family, ROUND(AVG(mastery_pct))::int AS mastery, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE status IN ('reliable','mastered'))::int AS solid
    FROM v_grammar_weakest GROUP BY family ORDER BY mastery`;
  const weakest = await sql`SELECT code, name, mastery_pct, status FROM v_grammar_weakest WHERE clb_needed <= (SELECT target_clb FROM learner) ORDER BY priority DESC LIMIT 5`;
  return { by_family: rows, weakest };
}
