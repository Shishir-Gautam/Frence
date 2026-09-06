// Learner stage + "known material".
//
// Stage BEGINNER (from zero): the day is a fixed syllabus, not an evidence-driven plan — there is no evidence yet.
// Everything the bot asks is drawn from lessons already passed. No exam-format tasks, no grid-driven grammar.
// Stage CORE: the Gemini planner takes over (grid, FSRS load, resources, history).
import { sql, one, getLearner, currentClb } from "./db.js";

export type Stage = "beginner" | "core";

export async function stage(): Promise<Stage> {
  const learner = await getLearner();
  const clb = await currentClb();
  const passed = await one`SELECT COUNT(*)::int AS n FROM resource_units WHERE status IN ('passed','mastered') AND resource_id IN ('assimil','coach_lessons')`;
  if (learner.settings?.stage === "core") return "core";
  if (clb.listening.clb >= 3 && clb.listening.confidence >= 0.4 && Number(passed?.n ?? 0) >= 8) return "core";
  if (Number(passed?.n ?? 0) >= 25) return "core";
  return "beginner";
}

/** Words and lines the learner has actually met: dialogues of passed/attempted lessons + cards. Compact text for prompts. */
export async function knownMaterial(maxLines = 80): Promise<{ lines: string[]; codes: string[]; lessons: number }> {
  const units = await sql`SELECT payload, seq FROM resource_units WHERE resource_id IN ('assimil','coach_lessons') AND status IN ('scheduled','attempted','passed','mastered') ORDER BY seq`;
  const lines: string[] = [], codes = new Set<string>();
  for (const u of units) {
    for (const d of u.payload?.dialogue ?? []) if (d?.fr) lines.push(d.fr);
    for (const c of u.payload?.codes ?? []) codes.add(c);
  }
  const cards = await sql`SELECT back FROM cards WHERE NOT suspended AND state <> 'new' ORDER BY reps DESC LIMIT 60`;
  for (const c of cards) lines.push(c.back);
  return { lines: [...new Set(lines)].slice(-maxLines), codes: [...codes], lessons: units.length };
}

export function knownClause(k: { lines: string[]; lessons: number }) {
  if (!k.lines.length) return "The learner knows NOTHING yet: use only greetings, je suis / je m'appelle / j'habite, numbers 1-10, and cognates.";
  return `The learner has met ONLY this material (${k.lessons} lessons). Use ONLY words and structures that appear here (recombining them is fine; introducing a new verb, tense or word is NOT):\n${k.lines.join(" | ")}`;
}

/** Mark the learner as starting from zero: no placement test, estimates fixed at CLB 1 with full confidence. */
export async function startFromZero() {
  for (const s of ["listening", "reading", "writing", "speaking"]) await sql`INSERT INTO skill_estimates (skill, clb, confidence, basis) VALUES (${s}::skill, 1, 1, '{"zero":true}'::jsonb)`;
  const learner = await getLearner();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: learner.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  await sql`UPDATE learner SET placement_done = TRUE, start_date = LEAST(start_date, ${today}::date),
            settings = settings || ${JSON.stringify({ stage: "beginner", zero_started_at: new Date().toISOString() })}::jsonb WHERE id = 1`;
  // clean slate: cards created by placement / exam-style tests before this point are not your material yet
  await sql`UPDATE cards SET suspended = TRUE WHERE unit_id IS NULL AND NOT (tags && ARRAY['unit_gate','drill_spot','coach_lessons','assimil'])`;
  await sql`UPDATE grammar_mastery SET mastery_pct = 0, confidence = 0, evidence_count = 0, correct_streak = 0, status = 'untouched'`;
}

export const INTRO = `🌱 <b>How this works</b>
1. A lesson arrives in three steps: <b>learn</b> (goal, new words with audio, the dialogue, what to notice) → <b>practice</b> (4 guided tries with hints, not scored) → <b>check</b> (5 short questions, scored). 80% = passed → next lesson tomorrow; below → the same lesson again with what you missed.
2. Cards arrive 3× a day: type the French. They only contain words from your lessons.
3. In the car: the lesson's lines as prompt → pause → answer. Say it out loud. A 5-question spot check comes later.
4. Evening: recall yesterday's lesson from English.
Every wrong answer has a ❓ Why? button. No commands needed. If something is stuck, /skip. Progress: /progress.`;
