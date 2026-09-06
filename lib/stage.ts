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
  await sql`UPDATE learner SET placement_done = TRUE, settings = settings || '{"stage":"beginner"}'::jsonb WHERE id = 1`;
}
