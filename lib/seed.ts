// Applies the schema and seeds the toolbox + grammar grid. Idempotent (upserts).
import { query, sql, json } from "./db.js";
import { SCHEMA } from "./schema.js";
import toolbox from "../content/resources/toolbox.json" with { type: "json" };
import competencies from "../content/grammar/competencies.json" with { type: "json" };

export async function applySchema() {
  // Split on statement boundaries but keep DO $$ ... $$ blocks intact.
  const stmts: string[] = [];
  let buf = "", inDollar = false;
  for (const line of SCHEMA.split("\n")) {
    if (line.includes("$$")) inDollar = !inDollar || !(line.split("$$").length - 1 === 2);
    buf += line + "\n";
    if (!inDollar && /;\s*(--.*)?$/.test(line)) { stmts.push(buf); buf = ""; }
  }
  if (buf.trim()) stmts.push(buf);
  for (const s of stmts) { const t = s.replace(/^\s*--.*$/gm, "").trim(); if (t) await query(t); }
}

export async function seedToolbox() {
  for (const r of toolbox as any[]) {
    await sql`INSERT INTO resources (id, title, kind, environments, skills, clb_min, clb_max, modality, minutes_per_unit, priority, cadence_rule, url, feed_url, how_to_use)
      VALUES (${r.id}, ${r.title}, ${r.kind}, ${r.environments}::environment[], ${r.skills}::skill[], ${r.clb_min}, ${r.clb_max}, ${r.modality}, ${r.minutes_per_unit}, ${r.priority}, ${r.cadence_rule}, ${r.url ?? null}, ${r.feed_url ?? null}, ${r.how_to_use})
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, kind=EXCLUDED.kind, environments=EXCLUDED.environments, skills=EXCLUDED.skills, clb_min=EXCLUDED.clb_min, clb_max=EXCLUDED.clb_max,
        modality=EXCLUDED.modality, minutes_per_unit=EXCLUDED.minutes_per_unit, priority=EXCLUDED.priority, cadence_rule=EXCLUDED.cadence_rule, url=EXCLUDED.url, feed_url=EXCLUDED.feed_url, how_to_use=EXCLUDED.how_to_use`;
  }
  return (toolbox as any[]).length;
}

export async function seedGrid() {
  let i = 0;
  for (const c of competencies as any[]) {
    i++;
    const desc = c.description + (c.test_focus ? `\nTEST FOCUS: ${c.test_focus.join("; ")}` : "");
    await sql`INSERT INTO grammar_competencies (code, family, name, description, clb_needed, exam_weight, prerequisites, sort_order)
      VALUES (${c.code}, ${c.family}, ${c.name}, ${desc}, ${c.clb_needed}, ${c.exam_weight}, ${c.prerequisites}, ${i})
      ON CONFLICT (code) DO UPDATE SET family=EXCLUDED.family, name=EXCLUDED.name, description=EXCLUDED.description, clb_needed=EXCLUDED.clb_needed, exam_weight=EXCLUDED.exam_weight, prerequisites=EXCLUDED.prerequisites, sort_order=EXCLUDED.sort_order`;
    await sql`INSERT INTO grammar_mastery (competency_code) VALUES (${c.code}) ON CONFLICT DO NOTHING`;
  }
  return i;
}

export async function seedAll() {
  await applySchema();
  const resources = await seedToolbox();
  const grid = await seedGrid();
  const start = process.env.STUDY_START_DATE, exam = process.env.TARGET_EXAM_DATE, tz = process.env.LEARNER_TZ;
  if (start) await sql`UPDATE learner SET start_date = LEAST(${start}::date, CURRENT_DATE) WHERE id = 1`;
  if (exam) await sql`UPDATE learner SET exam_date = COALESCE(exam_date, ${exam}) WHERE id = 1`;
  if (tz) await sql`UPDATE learner SET tz = ${tz} WHERE id = 1`;
  return { resources, grid };
}
