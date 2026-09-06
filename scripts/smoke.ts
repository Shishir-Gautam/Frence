// End-to-end smoke test against a real Postgres with Gemini + Telegram mocked at the fetch layer.
//   DATABASE_URL=postgres://... npm run smoke
// Exercises: schema+seed, units, gate check, FSRS typed cards, grammar evidence/mastery, drill authoring+render,
// spot check, grammar test, writing grading, planner+materialise, delivery pump, progress.
process.env.GEMINI_API_KEY ||= "test"; process.env.TELEGRAM_BOT_TOKEN ||= "t:est"; process.env.TELEGRAM_CHAT_ID ||= "42";

const sent: any[] = [];
let lastGeminiRole = "";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (url.includes("api.telegram.org")) {
    const method = url.split("/").pop()!;
    let body: any = {};
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : Object.fromEntries([...(init.body as any).entries()].map(([k, v]) => [k, typeof v === "string" ? v : "<file>"])); } catch {}
    sent.push({ method, text: body.text ?? body.caption ?? "", buttons: body.reply_markup });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length, voice: { file_id: "voice_" + sent.length }, poll: { id: "p" + sent.length } } }), { status: 200 });
  }
  if (url.includes("generativelanguage.googleapis.com")) {
    const body = JSON.parse(init.body);
    const sys: string = body.systemInstruction?.parts?.map((p: any) => p.text).join("") ?? "";
    const user: string = body.contents?.[0]?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
    if (body.generationConfig?.responseModalities?.includes("AUDIO")) {
      const pcm = Buffer.alloc(24000 * 2 * 1); // 1 s silence
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: pcm.toString("base64") } }] } }] }), { status: 200 });
    }
    const role = sys.match(/ACTIVE ROLE: ([A-Z ]+)/)?.[1]?.trim() ?? "";
    lastGeminiRole = role;
    const text = JSON.stringify(mockGemini(role, user));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  }
  return realFetch(input, init);
}) as any;

function mockGemini(role: string, user: string): any {
  if (role === "PLANNER") {
    const unitId = Number(user.match(/"unit_id":(\d+)/)?.[1]);
    const code = user.match(/TEACHABLE NOW[^\n]*\n\[\{"code":"([A-Z_]+)"/)?.[1] ?? "TNS_PRESENT_REG";
    return { focus: "smoke", rationale: "test", message_to_learner: "Go.", slots: [
      { environment: "patrol", slot: "patrol", minutes: 30, items: [{ type: "unit", resource_id: "assimil", unit_id: unitId, mode: "study" }, { type: "listening_set" }] },
      { environment: "micro", slot: "srs", minutes: 8, items: [{ type: "srs", count: 5 }] },
      { environment: "driving", slot: "driving", minutes: 20, items: [{ type: "drill", method: "pimsleur", competency_codes: [code] }] },
      { environment: "seated", slot: "seated", minutes: 40, items: [{ type: "grammar_brief", competency_code: code }, { type: "writing", task: "micro" }] },
    ] };
  }
  if (role === "DRILL AUTHOR") return { title: "Présent drill", script: [
    { type: "teach", en: "Today: I am, you are.", fr: "je suis, tu es" },
    ...Array.from({ length: 8 }, (_, i) => [{ type: "prompt", en: `I am tired ${i}`, pause_s: 3 }, { type: "answer", fr: `Je suis fatigué ${i}` }]).flat(),
    { type: "recap", en: "Recap.", fr: "je suis, tu es" }],
    spot_check: Array.from({ length: 5 }, (_, i) => ({ kind: "typed", prompt: `I am tired ${i}`, expected: `Je suis fatigué ${i}`, accept: [], competency_code: "TNS_PRESENT_IRREG" })) };
  if (role === "GRADER") return { task_type: "micro", clb_sub: 3.5, score_20: 6, criteria: { task_fulfilment: 4, coherence: 3, vocabulary: 3, grammar: 3, fluency_pronunciation: null },
    transcript: null, corrected_text: "Je suis gardien. J'habite à Toronto depuis un an.",
    corrections: [{ original: "j'ai habité à Toronto depuis un an", fix: "j'habite à Toronto depuis un an", why: "depuis + présent", competency_code: "TNS_INDICATEURS_TEMPS", error_type: "grammar" }],
    grammar_evidence: [{ competency_code: "TNS_PRESENT_IRREG", correct: true, excerpt: "je suis" }, { competency_code: "TNS_INDICATEURS_TEMPS", correct: false, excerpt: "j'ai habité depuis" }],
    new_cards: [{ front: "I have lived here for a year", back: "J'habite ici depuis un an", accept: [], kind: "grammar", competency_code: "TNS_INDICATEURS_TEMPS" }],
    strengths: ["clear"], next_focus: ["TNS_INDICATEURS_TEMPS"], feedback_en: "Good start. Fix depuis." };
  if (role === "EXAMINER") {
    if (/placement/i.test(user)) return { items: [
      { kind: "mcq", prompt: "« Bonjour » veut dire…", options: ["Hello", "Bye", "Thanks", "Yes"], answer_index: 0, item_clb: 1, skill: "reading" },
      { kind: "typed", prompt: "I live here for a year (since)", expected: "J'habite ici depuis un an", accept: ["j'habite ici depuis un an"], competency_code: "TNS_INDICATEURS_TEMPS", item_clb: 5 },
      { kind: "dictation", prompt: "Dictée", expected: "Il fait beau", accept: [], item_clb: 2, skill: "listening" }] };
    if (/Estimate starting CLB/.test(user)) return { listening: 1.5, reading: 2, writing: 1.5, speaking: 1, note: "beginner" };
    if (/Assimil lesson/.test(user) && /Write 5 items/.test(user)) return { items: [
      { kind: "typed", prompt: "Good morning", expected: "Bonjour", accept: [], item_clb: 1 },
      { kind: "typed", prompt: "How are you?", expected: "Comment allez-vous ?", accept: ["comment allez-vous", "comment vas-tu"], competency_code: "INT_TROIS_FORMES", item_clb: 1 },
      { kind: "dictation", prompt: "Dictée", expected: "Je vais bien", accept: [], item_clb: 1, skill: "listening" },
      { kind: "typed", prompt: "Make it negative: je vais bien", expected: "Je ne vais pas bien", accept: [], competency_code: "NEG_BASE", item_clb: 2 },
      { kind: "mcq", prompt: "« Merci » = ?", options: ["Thanks", "Sorry", "Please", "Hi"], answer_index: 0, item_clb: 1, skill: "reading" }] };
    if (/extract 8-12 flashcards/.test(user)) return { cards: [{ front: "good morning", back: "bonjour", accept: [], kind: "vocab", competency_code: null }, { front: "thank you", back: "merci", accept: [], kind: "vocab", competency_code: null }, { front: "I am (to be, 1sg)", back: "je suis", accept: [], kind: "grammar", competency_code: "TNS_PRESENT_IRREG" }] };
    if (/Competency/.test(user) && /brief_en/.test(user)) return { brief_en: "Rule.", examples: [{ fr: "Je parle", en: "I speak" }], items: Array.from({ length: 6 }, (_, i) => ({ kind: "typed", prompt: `I speak ${i}`, expected: `Je parle ${i}`, accept: [], competency_code: user.match(/Competency ([A-Z_]+)/)?.[1], item_clb: 3 })) };
    if (/LISTENING set/.test(user)) return { title: "À la gare", passage: "Le train part à huit heures.", items: [{ kind: "mcq", prompt: "Le train part à quelle heure ?", options: ["8 h", "9 h", "10 h", "11 h"], answer_index: 0, item_clb: 2, skill: "listening" }, { kind: "mcq", prompt: "Où ?", options: ["gare", "port", "école", "banque"], answer_index: 0, item_clb: 2, skill: "listening" }] };
    if (/READING set/.test(user)) return { title: "Annonce", text: "À louer : studio.", items: [{ kind: "mcq", prompt: "C'est quoi ?", options: ["un studio", "une maison", "un bureau", "un garage"], answer_index: 0, item_clb: 2, skill: "reading" }] };
    if (/Transcribe this French audio/.test(user)) return { transcript: "Je suis fatigué 0", correct: true, note: "ok" };
    if (/prompt_fr/.test(user)) return { prompt_fr: "Présentez-vous en 4 phrases.", instructions_en: "4 sentences.", helpers: ["je suis — I am"], target_codes: ["TNS_PRESENT_IRREG"] };
    if (/surprise retention/.test(user)) return { items: [{ kind: "typed", prompt: "thanks", expected: "merci", accept: [], item_clb: 1 }] };
    if (/cards/.test(user)) return { cards: [] };
    return { items: [] };
  }
  if (role === "TUTOR") { if (/Parse study time/.test(user)) return { entries: [{ minutes: 25, environment: "driving", activity: "podcast" }] }; return { summary_fr: "Résumé.", key_vocab: [{ fr: "gare", en: "station" }], clb_level: 5 }; }
  return {};
}

// ------------------------------------------------------------------ run
import { sql, one, getLearner } from "../lib/db.js";
import { seedAll } from "../lib/seed.js";
import { addCards, startSession, handleTyped, srsStats, abortSession as srs_abort_ } from "../lib/srs.js";
const srs_abort = () => srs_abort_(42);
import { recordEvidence, teachable } from "../lib/grammar.js";
import { buildPlan } from "../lib/planner.js";
import { runDelivery } from "../lib/deliver.js";
import { startUnitCheck } from "../lib/units.js";
import * as checks from "../lib/checks.js";
import { authorDrill, sendDrill, startSpotCheck } from "../lib/drills.js";
import { sendGrammarBrief, startGrammarTest } from "../lib/generate.js";
import { gradeWriting } from "../lib/grade.js";
import { sendProgress } from "../lib/progress.js";
import { localDate } from "../lib/time.js";

const assert = (c: any, m: string) => { if (!c) { console.error("❌ " + m); process.exit(1); } console.log("✓ " + m); };
const CHAT = 42;

for (const t of ["review_log", "cards", "unit_checks", "drill_sessions", "drills", "grammar_evidence", "submissions", "quiz_results", "activity_log", "deliveries", "plans", "resource_units", "kv", "skill_estimates", "tts_cache"]) await sql`DELETE FROM ${new (await import("../lib/db.js")).Raw(t)}`;
await sql`UPDATE grammar_mastery SET mastery_pct = 0, confidence = 0, evidence_count = 0, status = 'untouched', last_evidence = NULL`;

const seeded = await seedAll();
assert(seeded.grid === 44 && seeded.resources === 10, `schema applied, seeded ${seeded.grid} competencies / ${seeded.resources} resources`);
await sql`UPDATE learner SET chat_id = ${CHAT}, placement_done = FALSE WHERE id = 1`;

// two fake Assimil lessons
for (const n of [1, 2]) await sql`INSERT INTO resource_units (resource_id, seq, title, clb_level, skills, payload) VALUES ('assimil', ${n}, ${"Leçon " + n}, 1, ${["listening", "reading"]}, ${JSON.stringify({ dialogue: [{ fr: "Bonjour !", en: "Good morning!" }, { fr: "Comment allez-vous ?", en: "How are you?" }, { fr: "Je vais bien, merci.", en: "I am fine, thanks." }], notes: "n", exercises: [] })}::jsonb)`;

// placement
const pItems = await checks.authorPlacement();
await checks.startCheck({ chatId: CHAT, type: "placement", title: "Placement", items: pItems, env: "seated", pass_pct: 0 });
await checks.answer({ mcq: 0 });                          // correct
await checks.answer({ text: "j'ai habité ici depuis un an" }); // wrong (depuis)
await checks.answer({ text: "Il fait beau" });            // dictation correct
assert((await getLearner()).placement_done, "placement completes and sets estimates");
const ev = await one`SELECT correct FROM grammar_evidence WHERE competency_code = 'TNS_INDICATEURS_TEMPS' ORDER BY id DESC LIMIT 1`;
assert(ev && ev.correct === false, "depuis error became negative grammar evidence");

// grammar evidence -> mastery -> teachable
await recordEvidence("submission", null, Array.from({ length: 8 }, () => ({ competency_code: "TNS_PRESENT_REG", correct: true, weight: 1 })));
const m = await one`SELECT mastery_pct, status FROM grammar_mastery WHERE competency_code = 'TNS_PRESENT_REG'`;
assert(Number(m!.mastery_pct) > 60, `mastery recomputed: TNS_PRESENT_REG = ${m!.mastery_pct}% (${m!.status})`);
const t = await teachable(5);
assert(t.length > 0 && t.every((x: any) => x.code !== "TNS_PC_VS_IMP"), `teachable respects prerequisites (${t.map((x: any) => x.code).join(", ")})`);

// FSRS typed cards
await addCards([{ front: "the key", back: "la clé", accept: ["la cle"], competency_code: null, tags: ["unit_gate"] }, { front: "I am", back: "je suis", competency_code: "TNS_PRESENT_IRREG", tags: ["unit_gate"] }]);
await sql`UPDATE cards SET suspended = TRUE WHERE front NOT IN ('the key','I am')`;
await startSession(CHAT, 5, "micro");
assert(await handleTyped(CHAT, "la cle"), "typed answer accepted (accent-insensitive)");
assert(await handleTyped(CHAT, "je suit"), "near-miss handled");
const rl = await sql`SELECT rating, scheduled_days FROM review_log ORDER BY id`;
assert(rl.length === 2 && rl[0].rating >= 3 && rl[1].rating === 2, `review_log written with FSRS ratings ${rl.map((r) => r.rating).join(",")} / intervals ${rl.map((r) => r.scheduled_days).join(",")}d`);

// planner -> deliveries
const { date: today, plan } = await buildPlan();   // tomorrow: full materialisation + drill pre-authoring
assert(plan.focus.startsWith("Beginner track") && plan.slots.length >= 3, `beginner syllabus used (no Gemini planning): ${plan.slots.length} slots — ${plan.focus}`);
assert(plan.slots.find((s) => s.environment === "driving")!.items.some((i: any) => i.type === "drill" && i.unit_id), "beginner drill is built from the lesson unit");
assert(plan.slots.some((s) => s.items.some((i: any) => i.type === "drill" && i.drill_id)), "nightly plan pre-authored the drill");
assert(!plan.slots.some((s) => s.items.some((i: any) => i.type === "listening_set")), "listening set stripped for a CLB<3 learner");
const dl = await sql`SELECT slot, environment FROM deliveries WHERE plan_date = ${today} ORDER BY scheduled_at`;
assert(dl.length >= 1 + 1 + 3 + 1 + 1, `materialised ${dl.length} deliveries (${dl.map((d) => d.slot).join(",")})`);

// pump: force everything due, run patrol delivery
await sql`UPDATE deliveries SET scheduled_at = now() - interval '1 minute'`;
const patrol = await one`SELECT id, slot, environment, payload, plan_date::text AS plan_date FROM deliveries WHERE environment = 'patrol'`;
await runDelivery(patrol as any);
assert(sent.some((s) => s.method === "sendVoice"), "patrol slot sent lesson voice notes (TTS mocked)");
const unitId = Number(patrol!.payload.items[0].unit_id);
await startUnitCheck(CHAT, unitId, "patrol", Number(patrol!.id));
await checks.answer({ text: "bonjour" }); await checks.answer({ text: "Comment vas-tu" }); await checks.answer({ text: "Je vais bien" }); await checks.answer({ text: "Je ne vais pas bien" }); await checks.answer({ mcq: 0 });
const u = await one`SELECT status, best_score FROM resource_units WHERE id = ${unitId}`;
assert(u!.status === "passed", `gate check passed -> unit status '${u!.status}' (${u!.best_score}%)`);
assert((await one`SELECT status FROM deliveries WHERE id = ${patrol!.id}`)!.status === "completed", "delivery marked completed only after the check");

// collision: a card session running when a check starts gets paused; cards deferred behind a check resume after it
await sql`UPDATE cards SET suspended = FALSE`;
await startSession(CHAT, 5, "micro");
assert(!!(await one`SELECT 1 FROM kv WHERE k = 'srs_session'`), "card session open");
await checks.startCheck({ chatId: CHAT, type: "grammar_test", title: "collision", items: [{ kind: "typed", prompt: "hello", expected: "bonjour", accept: [] }], env: "seated", pass_pct: 80 });
assert(!(await one`SELECT 1 FROM kv WHERE k = 'srs_session'`), "check start paused the card session");
await startSession(CHAT, 5, "micro");
assert(!!(await one`SELECT 1 FROM kv WHERE k = 'srs_deferred'`), "cards deferred while a check is open");
await checks.answer({ text: "bonjour" });
assert(!!(await one`SELECT 1 FROM kv WHERE k = 'srs_session'`) && !(await one`SELECT 1 FROM kv WHERE k = 'srs_deferred'`), "deferred cards resumed after the check");
await srs_abort();

// drill: author + render + spot check
const code = (await teachable(1))[0].code;
const drillId = await authorDrill({ method: "pimsleur", competency_codes: [code] });
await sendDrill(CHAT, drillId);
const d = await one`SELECT audio_file, duration_s FROM drills WHERE id = ${drillId}`;
assert(d!.audio_file && d!.duration_s! > 30, `drill rendered to one MP3 (${d!.duration_s}s incl. pauses) and cached by file_id`);
assert(Number((await one`SELECT COUNT(*)::int AS n FROM tts_cache`)!.n) > 5, "TTS segments cached");
await startSpotCheck(CHAT, drillId);
for (let i = 0; i < 5; i++) await checks.answer({ text: `je suis fatigué ${i}` });
assert(Number((await one`SELECT score_pct FROM drill_sessions WHERE drill_id = ${drillId}`)!.score_pct) === 100, "post-drive spot check scored and stored");

// grammar brief + test
await sendGrammarBrief(CHAT, code); await startGrammarTest(CHAT, code);
for (let i = 0; i < 6; i++) await checks.answer({ text: i < 5 ? `je parle ${i}` : "wrong" });
const gm = await one`SELECT mastery_pct, evidence_count, status FROM grammar_mastery WHERE competency_code = ${code}`;
assert(Number(gm!.evidence_count) >= 6, `grammar test -> evidence (${code}: ${gm!.mastery_pct}%, ${gm!.status})`);

// writing grading
await sql`INSERT INTO submissions (skill, task_type, environment, prompt) VALUES ('writing','micro','seated','Présentez-vous')`;
await gradeWriting(CHAT, "Je suis gardien. J'ai habité à Toronto depuis un an.");
const sub = await one`SELECT clb_sub, score_20 FROM submissions WHERE graded_at IS NOT NULL ORDER BY id DESC LIMIT 1`;
assert(Number(sub!.clb_sub) === 3.5, `grader stored clb_sub ${sub!.clb_sub} / ${sub!.score_20}/20`);
const est = await one`SELECT clb FROM v_current_clb WHERE skill = 'writing'`;
assert(Number(est!.clb) === 3.5, "writing CLB estimate updated from submissions");
assert(Number((await one`SELECT COUNT(*)::int AS n FROM cards WHERE competency_code = 'TNS_INDICATEURS_TEMPS'`)!.n) >= 1, "error card created with competency tag");

// progress
await sendProgress(CHAT);
assert(sent.at(-1).text.includes("Beginner track"), "progress card renders the beginner view (lessons, not the exam grid)");
const st = await srsStats();
console.log("srs:", st, "\nmessages sent:", sent.length, "| last Gemini role:", lastGeminiRole);
console.log("\nALL SMOKE CHECKS PASSED");
process.exit(0);
