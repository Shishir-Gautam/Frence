// The module layer + capability matrix (ARCHITECTURE §2, §3.5).
//
// A module is one durable capability and the join between the four curricula that used to float
// apart: the 40-unit ladder, the 44-competency grammar grid, the TCF exam model and the toolbox.
//
// module_state is DERIVED. Nothing here is hand-set: every cell is recomputed from evidence the
// bot already collects, so the matrix cannot drift from what actually happened.
import { sql } from "./db.js";
import modulesJson from "../content/curriculum/modules.json" with { type: "json" };

export type Skill = "listening" | "reading" | "writing" | "speaking";
export type Family = "foundation" | "functional" | "comprehension" | "production" | "exam";
export type Module = {
  id: string; family: Family; name: string; can_do: string; clb_band: [number, number];
  requires: string[]; units: number[]; competency_codes: string[]; skills: Skill[];
  exam_tasks: string[]; environments: string[]; resources: string[];
};
export type State = "unseen" | "introduced" | "practicing" | "competent" | "retaining" | "mastered" | "maintenance";

export const MODULES = (modulesJson as any).modules as Module[];
export const FAMILIES = (modulesJson as any).families as Record<Family, string>;
export const FAMILY_ORDER: Family[] = ["foundation", "functional", "comprehension", "production", "exam"];
export const byId = (id: string) => MODULES.find((m) => m.id === id);
export const moduleForUnitSeq = (seq: number) => MODULES.find((m) => m.units.includes(seq));

export const STATE_RANK: Record<State, number> = {
  unseen: 0, introduced: 1, practicing: 2, competent: 3, retaining: 4, mastered: 5, maintenance: 5,
};

// How much one observation is worth. Free production is the real thing; a card is a hint.
const WEIGHT: Record<string, number> = { submission: 1.0, quiz: 0.8, unit_check: 0.7, drill_session: 0.6, card_review: 0.4, rescue: 0.5 };

type Obs = { correct: boolean; weight: number; at: Date; exam: boolean };

/**
 * Everything the matrix needs, in six queries instead of ~135.
 * Recomputing 27 modules x 2 skills with per-module queries meant a /state that took seven seconds
 * and held a Neon connection the whole time; the evidence tables are small enough to pull once and
 * filter in memory.
 */
type Snapshot = {
  unitIdBySeq: Map<number, number>;
  ladderIds: Set<number>;
  taught: Set<number>;                                     // unit ids with status <> 'unseen'
  retention: Map<number, { sum: number; n: number }>;      // unit id -> normalised stability
  quiz: { skill: string; correct: boolean; unit_id: number | null; item_clb: number; at: Date }[];
  gram: { code: string; correct: boolean; source: string; at: Date }[];
  subs: { skill: string; task: string; ok: boolean; at: Date }[];
  checks: { unit_id: number; passed: boolean; at: Date }[];
};

async function snapshot(): Promise<Snapshot> {
  const units = await sql`SELECT id, seq, status FROM resource_units WHERE resource_id IN ('assimil','coach_lessons')`;
  const cards = await sql`SELECT unit_id, AVG(LEAST(1.0, stability / 21.0))::float AS ret, COUNT(*)::int AS n
                            FROM cards WHERE unit_id IS NOT NULL AND NOT suspended AND state <> 'new' GROUP BY unit_id`;
  const quiz = await sql`SELECT skill::text AS skill, correct, unit_id, item_clb::float AS item_clb, created_at
                           FROM quiz_results WHERE created_at > now() - interval '120 days'`;
  const gram = await sql`SELECT competency_code, correct, source_type, created_at
                           FROM grammar_evidence WHERE created_at > now() - interval '120 days'`;
  const subs = await sql`SELECT skill::text AS skill, task_type, score_20::float AS score_20, graded_at
                           FROM submissions WHERE graded_at IS NOT NULL AND graded_at > now() - interval '120 days'`;
  const checks = await sql`SELECT unit_id, passed, created_at FROM unit_checks WHERE created_at > now() - interval '120 days'`;

  const unitIdBySeq = new Map<number, number>(), ladderIds = new Set<number>(), taught = new Set<number>();
  for (const u of units) {
    const id = Number(u.id);
    ladderIds.add(id);
    if (u.seq !== null) unitIdBySeq.set(Number(u.seq), id);
    if (u.status !== "unseen") taught.add(id);
  }
  return {
    unitIdBySeq, ladderIds, taught,
    retention: new Map(cards.map((c) => [Number(c.unit_id), { sum: Number(c.ret) * Number(c.n), n: Number(c.n) }])),
    quiz: quiz.map((q) => ({ skill: q.skill, correct: !!q.correct, unit_id: q.unit_id === null ? null : Number(q.unit_id), item_clb: Number(q.item_clb), at: new Date(q.created_at) })),
    gram: gram.map((g) => ({ code: g.competency_code, correct: !!g.correct, source: g.source_type, at: new Date(g.created_at) })),
    subs: subs.map((x) => ({ skill: x.skill, task: x.task_type, ok: Number(x.score_20 ?? 0) >= 12, at: new Date(x.graded_at) })),
    checks: checks.map((c) => ({ unit_id: Number(c.unit_id), passed: !!c.passed, at: new Date(c.created_at) })),
  };
}

/** Every observation that speaks to (module, skill), from the sources that can be attributed to it. */
function observations(m: Module, skill: Skill, ids: number[], snap: Snapshot): Obs[] {
  const out: Obs[] = [];
  const idSet = new Set(ids);

  if (skill === "listening" || skill === "reading") {
    // Receptive items are attributed by the unit they came from. A module with no ladder units
    // (the comprehension family) takes native/generated items inside its CLB band instead.
    for (const q of snap.quiz) {
      if (q.skill !== skill) continue;
      const mine = ids.length
        ? q.unit_id !== null && idSet.has(q.unit_id)
        : (q.unit_id === null || !snap.ladderIds.has(q.unit_id)) && q.item_clb >= m.clb_band[0] && q.item_clb <= m.clb_band[1];
      if (mine) out.push({ correct: q.correct, weight: WEIGHT.quiz, at: q.at, exam: q.unit_id === null });
    }
  }

  if (skill === "writing" || skill === "speaking") {
    // Productive evidence: the grammar observations this module's competencies generated, split by
    // how they were produced — typed production counts as writing, spoken drills as speaking.
    const sources = skill === "writing" ? ["submission", "unit_check", "card_review"] : ["drill_session", "submission"];
    const codes = new Set(m.competency_codes);
    for (const g of snap.gram)
      if (codes.has(g.code) && sources.includes(g.source))
        out.push({ correct: g.correct, weight: WEIGHT[g.source] ?? 0.5, at: g.at, exam: false });

    // Graded tasks in this module's own exam formats are the strongest evidence it has.
    const tasks = new Set(m.exam_tasks);
    for (const s of snap.subs)
      if (s.skill === skill && tasks.has(s.task))
        out.push({ correct: s.ok, weight: WEIGHT.submission, at: s.at, exam: true });
  }

  // Gate checks on the module's own lessons count as typed production.
  if (skill === "writing")
    for (const c of snap.checks)
      if (idSet.has(c.unit_id)) out.push({ correct: c.passed, weight: WEIGHT.unit_check, at: c.at, exam: false });

  return out;
}

/** Recency-weighted accuracy, shrunk toward 0.5 while the evidence is thin (same estimator as the grammar grid). */
function score(obs: Obs[]) {
  if (!obs.length) return { score: 0, confidence: 0, n: 0 };
  const sorted = [...obs].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 40);
  const now = Date.now();
  let num = 0, den = 0;
  sorted.forEach((o, i) => {
    const ageDays = (now - o.at.getTime()) / 86400000;
    const w = o.weight * Math.exp(-i / 12) * Math.exp(-ageDays / 45);
    num += (o.correct ? 1 : 0) * w; den += w;
  });
  const n = sorted.length;
  const raw = den ? num / den : 0.5;
  const shrink = n / (n + 4);
  return { score: raw * shrink + 0.5 * (1 - shrink), confidence: Math.min(1, n / 12), n };
}

/** Average card stability for this module's material, normalised against a 21-day target. */
function retentionOf(ids: number[], snap: Snapshot): number | null {
  let sum = 0, n = 0;
  for (const id of ids) { const r = snap.retention.get(id); if (r) { sum += r.sum; n += r.n; } }
  return n > 0 ? sum / n : null;
}

/**
 * The state ladder. Deterministic, so the matrix is auditable rather than a vibe.
 * The retention gate is the point of §12.3: performance and durability are different claims —
 * a module cannot be called 'retaining' while the cards carrying it sit under 14 days of stability.
 */
function transition(prev: any, s: { score: number; confidence: number; n: number }, obs: Obs[], retention: number | null, taught: boolean): { state: State; first_competent: Date | null; next_probe: Date | null } {
  const first = prev?.first_competent ? new Date(prev.first_competent) : null;
  const last = obs.length ? new Date(Math.max(...obs.map((o) => o.at.getTime()))) : null;
  const examN = obs.filter((o) => o.exam).length;
  const spreadDays = obs.length > 1 ? (Math.max(...obs.map((o) => o.at.getTime())) - Math.min(...obs.map((o) => o.at.getTime()))) / 86400000 : 0;

  if (!s.n) return { state: taught ? "introduced" : "unseen", first_competent: first, next_probe: null };
  if (s.n < 3) return { state: "introduced", first_competent: first, next_probe: null };
  if (s.score < 0.70 || s.n < 5) return { state: "practicing", first_competent: first, next_probe: null };

  const competentSince = first ?? new Date();
  const durable = retention === null || retention >= 14 / 21;                  // no cards yet = not yet contradicted
  const daysSince = (Date.now() - competentSince.getTime()) / 86400000;
  const survived = daysSince >= 14 && !!last && last.getTime() > competentSince.getTime() + 14 * 86400000;

  if (s.score >= 0.85 && s.n >= 8 && examN >= 2 && spreadDays >= 21 && durable) {
    const idle = last ? (Date.now() - last.getTime()) / 86400000 : 999;
    return idle >= 30
      ? { state: "maintenance", first_competent: competentSince, next_probe: new Date(Date.now() + 7 * 86400000) }
      : { state: "mastered", first_competent: competentSince, next_probe: new Date(Date.now() + 30 * 86400000) };
  }
  if (survived && durable) return { state: "retaining", first_competent: competentSince, next_probe: null };
  return { state: "competent", first_competent: competentSince, next_probe: null };
}

/** Nightly (and on demand): rebuild every cell from evidence. Additive — changes no behaviour yet. */
export async function recomputeAll() {
  const snap = await snapshot();
  const prevRows = await sql`SELECT module_id, skill::text AS skill, first_competent FROM module_state`;
  const prevs = new Map(prevRows.map((r) => [`${r.module_id}:${r.skill}`, r]));
  for (const m of MODULES) {
    const ids = m.units.map((seq) => snap.unitIdBySeq.get(seq)).filter((x): x is number => typeof x === "number");
    const taught = ids.some((id) => snap.taught.has(id));
    const retention = retentionOf(ids, snap);
    for (const skill of m.skills) {
      const obs = observations(m, skill, ids, snap);
      const s = score(obs);
      const prev = prevs.get(`${m.id}:${skill}`);
      const t = transition(prev, s, obs, retention, taught);
      const last = obs.length ? new Date(Math.max(...obs.map((o) => o.at.getTime()))) : null;
      await sql`INSERT INTO module_state (module_id, skill, state, score, confidence, evidence_count, exam_evidence_count, retention, first_competent, last_evidence, next_probe, updated_at)
        VALUES (${m.id}, ${skill}::skill, ${t.state}, ${s.score.toFixed(3)}, ${s.confidence.toFixed(2)}, ${s.n}, ${obs.filter((o) => o.exam).length},
                ${retention === null ? null : retention.toFixed(3)}, ${t.first_competent?.toISOString() ?? null}, ${last?.toISOString() ?? null}, ${t.next_probe?.toISOString() ?? null}, now())
        ON CONFLICT (module_id, skill) DO UPDATE SET state = EXCLUDED.state, score = EXCLUDED.score, confidence = EXCLUDED.confidence,
          evidence_count = EXCLUDED.evidence_count, exam_evidence_count = EXCLUDED.exam_evidence_count, retention = EXCLUDED.retention,
          first_competent = EXCLUDED.first_competent, last_evidence = EXCLUDED.last_evidence, next_probe = EXCLUDED.next_probe, updated_at = now()`;
    }
  }
}

export type Cell = { module_id: string; skill: Skill; state: State; score: number; confidence: number; evidence_count: number; retention: number | null };

export async function matrix(): Promise<Map<string, Cell[]>> {
  const rows = await sql`SELECT module_id, skill::text AS skill, state, score::float, confidence::float, evidence_count, retention::float FROM module_state`;
  const byModule = new Map<string, Cell[]>();
  for (const r of rows) {
    const c: Cell = { module_id: r.module_id, skill: r.skill, state: r.state, score: Number(r.score), confidence: Number(r.confidence), evidence_count: Number(r.evidence_count), retention: r.retention === null ? null : Number(r.retention) };
    byModule.set(c.module_id, [...(byModule.get(c.module_id) ?? []), c]);
  }
  return byModule;
}

/** A module is unlocked when every prerequisite has reached 'competent' in at least one skill. */
export function unlocked(m: Module, mx: Map<string, Cell[]>): boolean {
  return m.requires.every((r) => (mx.get(r) ?? []).some((c) => STATE_RANK[c.state] >= STATE_RANK.competent));
}

/** The weakest cell of an unlocked, unfinished module — what tomorrow should attack. */
export async function bottleneck(mx?: Map<string, Cell[]>): Promise<{ module: Module; cell: Cell } | null> {
  const m = mx ?? (await matrix());
  let best: { module: Module; cell: Cell; priority: number } | null = null;
  for (const mod of MODULES) {
    if (!unlocked(mod, m)) continue;
    for (const cell of m.get(mod.id) ?? []) {
      if (STATE_RANK[cell.state] >= STATE_RANK.mastered) continue;
      // touched-but-weak beats never-touched: an open capability is worth more than a new one
      const priority = (1 - cell.score) * (cell.evidence_count > 0 ? 1.2 : 0.8) * (7 - Math.min(7, mod.clb_band[0])) / 7 + 0.001;
      if (!best || priority > best.priority) best = { module: mod, cell, priority };
    }
  }
  return best ? { module: best.module, cell: best.cell } : null;
}
