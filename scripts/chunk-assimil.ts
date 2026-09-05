// Chunk "Assimil - French with Ease" PDF into structured lessons using Gemini's native PDF reading
// (works for scanned PDFs too). Output: content/assimil/lessons.json  -> then `npm run assimil:load`.
//
//   GEMINI_API_KEY=... npx tsx scripts/chunk-assimil.ts /path/to/french-with-ease.pdf [fromLesson] [toLesson]
//
import "dotenv/config";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const [pdfPath, fromArg, toArg] = process.argv.slice(2);
if (!pdfPath) { console.error("usage: chunk-assimil.ts <pdf> [from] [to]"); process.exit(1); }
const FROM = Number(fromArg ?? 1), TO = Number(toArg ?? 113), BATCH = 5;
const OUT = "content/assimil/lessons.json";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
const MODEL = (process.env.GEMINI_MODEL || "gemini-3.8-flash").split(",")[0].trim();

type Lesson = { n: number; title: string; dialogue: { fr: string; en: string }[]; notes: string; exercises: { fr: string; en: string }[] };

async function main() {
  mkdirSync("content/assimil", { recursive: true });
  const existing: Lesson[] = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : [];
  const byN = new Map(existing.map((l) => [l.n, l]));

  console.log("Uploading PDF to Gemini Files API…");
  const file = await ai.files.upload({ file: pdfPath, config: { mimeType: "application/pdf" } });
  let f = file;
  while (f.state === "PROCESSING") { await new Promise((r) => setTimeout(r, 2000)); f = await ai.files.get({ name: f.name! }); }
  if (f.state === "FAILED") throw new Error("upload failed");
  const filePart = createPartFromUri(f.uri!, f.mimeType!);

  for (let a = FROM; a <= TO; a += BATCH) {
    const b = Math.min(TO, a + BATCH - 1);
    if ([...Array(b - a + 1)].every((_, i) => byN.has(a + i))) { console.log(`lessons ${a}-${b} already done`); continue; }
    console.log(`Extracting lessons ${a}-${b}…`);
    const r = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [filePart, { text:
`This is the Assimil "French with Ease" textbook. Extract lessons ${a} to ${b} inclusive, exactly as printed.
For each lesson return: n (lesson number), title (French title as printed), dialogue = every numbered line of the French text on the left page paired with its English translation from the facing right page, in order (keep the numbering order, strip the numbers; include the title line as line 0 if it is translated), notes = the numbered footnotes/grammar notes of the lesson merged into one plain-text block (keep the numbering), exercises = the "Exercice" sentences with their English translations (skip the fill-in-the-blanks unless answers are printed).
Every 7th lesson is a revision lesson ("Révision et notes"): for those, put the revision text in notes and leave dialogue as an empty array, title = "Révision".
Keep all French accents. Do not summarise or invent. Return JSON: {"lessons":[{n,title,dialogue:[{fr,en}],notes,exercises:[{fr,en}]}]}` }] }],
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    const parsed = JSON.parse(r.text ?? "{}");
    for (const l of parsed.lessons ?? []) { byN.set(l.n, l); console.log(`  ✓ lesson ${l.n}: ${l.title} (${l.dialogue?.length ?? 0} lines)`); }
    writeFileSync(OUT, JSON.stringify([...byN.values()].sort((x, y) => x.n - y.n), null, 1));
  }
  console.log(`Saved ${byN.size} lessons to ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
