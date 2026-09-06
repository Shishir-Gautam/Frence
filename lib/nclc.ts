// NCLC / TCF Canada readiness.
//
// Two numbers that must never be confused:
//   - ABILITY   : what the estimator thinks you can do (skill_estimates, fed by graded work). An opinion.
//   - VALIDATION: how much of the evidence behind it was TCF-shaped. A fact about the evidence, not about you.
// So the readiness card always prints the estimate AND what backs it. "NCLC 6 (AI estimate, 0 exam-format
// tasks)" and "NCLC 6 (mock-validated)" are very different claims and the bot is not allowed to blur them.
//
// Evidence is written from day one (recordExam) even while the answer is "not enough to say" — the alternative
// is discovering in month 6 that the measurement layer has no history to work from.
import { sql, one, currentClb } from "./db.js";
import { sendMessage, esc } from "./telegram.js";
import bands from "../content/exam/nclc-bands.json" with { type: "json" };

export type Component = "listening" | "reading" | "writing" | "speaking";
export const COMPONENTS: Component[] = ["listening", "reading", "writing", "speaking"];
const LEVELS = Object.keys(bands.levels).map(Number).sort((a, b) => a - b);   // 4..10

/** Raw TCF score band for a whole NCLC level. Below 4 the test itself doesn't resolve levels, so: null. */
export function band(component: Component, level: number): [number, number] | null {
  const l = Math.floor(level);
  const row = (bands.levels as any)[String(l)];
  return row ? (row[component] as [number, number]) : null;
}

/** Where a fractional estimate lands inside its band, e.g. 6.5 listening -> ~428 (100-699 scale). */
export function projectedScore(component: Component, clb: number): number | null {
  const b = band(component, clb);
  if (!b) return null;
  const frac = Math.max(0, Math.min(0.999, clb - Math.floor(clb)));
  return Math.round(b[0] + (b[1] - b[0]) * frac);
}

export const scale = (c: Component) => (bands.scales as any)[c] as string;
export const targetBand = (c: Component) => band(c, bands.target)!;

/** Distance to the target expressed in whole levels, for the planner and the weekly report. */
export function gapToTarget(clb: number) { return Math.max(0, bands.target - clb); }

export type Validation = "none" | "ai_estimate" | "test_backed" | "mock_validated";
const VALIDATION_LABEL: Record<Validation, string> = {
  none: "no evidence yet",
  ai_estimate: "AI estimate",
  test_backed: "test-backed",
  mock_validated: "mock-validated",
};

export type Readiness = {
  component: Component;
  clb: number; confidence: number;
  score: number | null; band: [number, number] | null; scale: string;
  items: number; exam_items: number; mock_items: number; hi_items: number; hi_correct: number;
  validation: Validation; label: string;
  at_target: boolean;
};

/**
 * Validation ladder — deliberately hard to climb:
 *   none          nothing scored yet
 *   ai_estimate   graded work exists, but little or none of it was TCF-shaped
 *   test_backed   ≥8 exam-format items/tasks AND ≥4 of them at CLB 6+ (where NCLC 7 is actually decided)
 *   mock_validated a full timed mock section has been sat
 */
function validationOf(r: { items: number; exam_items: number; mock_items: number; hi_items: number }): Validation {
  if (r.mock_items > 0) return "mock_validated";
  if (r.exam_items >= 8 && r.hi_items >= 4) return "test_backed";
  if (r.items > 0) return "ai_estimate";
  return "none";
}

export async function readiness(): Promise<Readiness[]> {
  const clb = await currentClb();
  const rows = await sql`SELECT * FROM v_exam_readiness`;
  const by = new Map(rows.map((r) => [String(r.component), r]));
  return COMPONENTS.map((c) => {
    const r = by.get(c) ?? {};
    const counts = {
      items: Number(r.items ?? 0), exam_items: Number(r.exam_items ?? 0),
      mock_items: Number(r.mock_items ?? 0), hi_items: Number(r.hi_items ?? 0),
    };
    const validation = validationOf(counts);
    const level = Number(clb[c].clb) || 1;
    return {
      component: c, clb: level, confidence: Number(clb[c].confidence) || 0,
      score: projectedScore(c, level), band: band(c, level), scale: scale(c),
      ...counts, hi_correct: Number(r.hi_correct ?? 0),
      validation, label: VALIDATION_LABEL[validation],
      at_target: level >= bands.target,
    };
  });
}

/** Write one piece of exam evidence. Cheap and idempotent-ish: called from every scored path. */
export async function recordExam(e: {
  component: Component; source: "quiz_item" | "submission" | "live" | "mock"; source_id?: number | null;
  exam_format?: boolean; item_clb: number; correct?: boolean | null; weight?: number;
}) {
  const clb = Math.max(1, Math.min(12, Number(e.item_clb) || 1));
  await sql`INSERT INTO exam_evidence (component, source, source_id, exam_format, item_clb, correct, weight)
            VALUES (${e.component}::skill, ${e.source}, ${e.source_id ?? null}, ${!!e.exam_format}, ${clb}::numeric,
                    ${e.correct === undefined ? null : e.correct}, ${e.weight ?? 1}::numeric)`;
}

/** Bulk version for a finished check: only listening/reading items carry a component. */
export async function recordExamItems(items: { skill?: string; item_clb?: number; correct?: boolean }[], opts: { exam_format: boolean; source_id?: number | null }) {
  for (const i of items) {
    if (i.skill !== "listening" && i.skill !== "reading") continue;
    await recordExam({ component: i.skill, source: "quiz_item", source_id: opts.source_id ?? null, exam_format: opts.exam_format, item_clb: i.item_clb ?? 3, correct: !!i.correct });
  }
}

const NAME: Record<Component, string> = { listening: "Listening", reading: "Reading", writing: "Writing", speaking: "Speaking" };

/** The readiness card: estimate, projected TCF score, and exactly what backs it. */
export async function sendReadiness(chatId: number) {
  const { updateReceptiveEstimates } = await import("./grade.js");
  await updateReceptiveEstimates();
  const rows = await readiness();
  const learner = await one`SELECT exam_date::text AS exam_date FROM learner WHERE id = 1`;
  const body = rows.map((r) => {
    const lvl = r.validation === "none" ? "  —  " : `NCLC ${r.clb.toFixed(1)}`;
    const sc = r.validation === "none" || !r.score ? "—" : r.clb < 4 ? "below 4" : String(r.score);
    return `${NAME[r.component].padEnd(10)} ${lvl.padStart(9)}  ${sc.padStart(7)}  ${r.at_target ? "✅" : "▫️"}  ${r.label}${r.items ? ` (${r.exam_items}/${r.items} exam-format)` : ""}`;
  }).join("\n");
  const worst = rows.reduce((a, b) => (b.clb < a.clb ? b : a));
  const mocks = rows.reduce((n, r) => n + r.mock_items, 0);
  const tgt = COMPONENTS.map((c) => `${NAME[c].slice(0, 1)} ${targetBand(c)[0]}–${targetBand(c)[1]}`).join(" · ");
  await sendMessage(chatId,
    `🇨🇦 <b>TCF Canada — estimated performance today</b>\n<pre>${esc(body)}</pre>` +
    `🎯 NCLC 7 needs ${esc(tgt)} <i>(listening/reading on 100–699, speaking/writing on 0–20)</i>\n` +
    `🧪 <b>Exam validation:</b> ${mocks ? `${mocks} mock section${mocks === 1 ? "" : "s"} sat` : "no full mock yet"}.\n\n` +
    `<i>IRCC requires NCLC 7 in all four. Weakest right now: ${NAME[worst.component].toLowerCase()}${worst.validation === "none" ? "" : ` (${worst.clb.toFixed(1)})`}.</i>` +
    (learner?.exam_date ? `\n📅 Exam: ${esc(learner.exam_date)}` : "") +
    `\n\n<i>"AI estimate" means the grader's opinion of your recent work. It becomes "test-backed" after 8 exam-format items with 4 at CLB 6+, and "mock-validated" only after a timed mock section.</i>`);
}
