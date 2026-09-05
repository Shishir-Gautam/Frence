// Load content/assimil/lessons.json (from assimil:chunk) into resource_units for resource 'assimil'.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql, json } from "../lib/db.js";
const lessons = JSON.parse(readFileSync("content/assimil/lessons.json", "utf8"));
for (const l of lessons) {
  const clb = l.n <= 21 ? 1 : l.n <= 49 ? 2 : l.n <= 84 ? 3 : 4;
  await sql`INSERT INTO resource_units (resource_id, seq, title, clb_level, skills, payload)
    VALUES ('assimil', ${l.n}, ${l.title ?? null}, ${clb}, ${["listening", "reading"]}, ${json({ dialogue: l.dialogue ?? [], notes: l.notes ?? "", exercises: l.exercises ?? [] })}::jsonb)
    ON CONFLICT (resource_id, seq) DO UPDATE SET title = EXCLUDED.title, payload = EXCLUDED.payload, clb_level = EXCLUDED.clb_level`;
}
console.log(`loaded ${lessons.length} Assimil lessons`); process.exit(0);
