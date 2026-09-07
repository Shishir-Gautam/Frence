# french-bot — system architecture

The target: **NCLC 7 on the TCF Canada**, from zero, in ~7 months of 2h/day, with no daily decisions made by the learner.

This document is the thing we build toward. It names every component, its contract, the tables it owns, and
whether it exists today. Nothing here is aspirational prose — if a section says *missing*, there is a build
step for it at the bottom.

---

## 0. The one-paragraph version

The system holds a **model of the learner**. A **deterministic selector** reads that model plus the learner's
current physical environment and emits the single highest-value activity available right now. Gemini **authors
and grades** that activity but never chooses it. Every answer becomes **evidence**; evidence updates the model;
the model changes what comes next. Exam readiness is a separate, evidence-gated read of the same model, never
an average of vibes.

```
Curriculum (fixed)  ──┐
Learner model        ─┼─→  Selector (deterministic)  ─→  Authoring (Gemini)  ─→  Delivery (Telegram)
Environment + time   ──┘                    ▲                                        │
                                            └──────── Evidence ←── Grading (Gemini) ─┘
```

The critical rule, and the one the current code half-breaks:

> **The selector is deterministic. The LLM is a renderer and a grader.**

An LLM that chooses the curriculum each night cannot be audited, cannot be reproduced, drifts, and dies on a
429. A deterministic selector can be unit-tested, explains itself for free, and works when the quota is gone.

---

## 1. Layers

| # | Layer | Owns | Today |
|---|-------|------|-------|
| 1 | **Curriculum** | modules, grammar competencies, unit ladder, exam model, resource toolbox | 4 of 5 exist, **unjoined** |
| 2 | **Learner model** | skill estimates, module×skill capability, grammar mastery, FSRS ledger, error log, exam evidence | exists, **no module layer** |
| 3 | **Selector** | the priority queue: what next, for how long, in which environment | **missing** (an LLM prompt does this) |
| 4 | **Authoring** | turn (module, skill, environment, minutes) into a concrete activity | exists (`teach`, `drills`, `checks`, `live`) |
| 5 | **Delivery** | slots, queue, Telegram rendering, TTS, one-item-at-a-time flow | exists and works |
| 6 | **Assessment** | grade → evidence → model update | exists (`grade`, `grammar`, `srs`, `nclc`) |
| 7 | **Pacing** | 6-month macro focus, on/off-pace response, exam-format ratio | **missing** |

Layers 1, 2, 4, 5, 6 are built. **Layer 3 is the hole**, and layer 1 has four curricula that don't reference
each other. Everything below follows from those two facts.

---

## 2. Curriculum layer

### 2.1 What exists, and why it isn't enough

| Artifact | What it is | Problem |
|---|---|---|
| `content/curriculum/beginner.json` | 40 units, 3 stages, linear | a *sequence*, not a graph; says nothing about skills or exam tasks |
| `content/grammar/competencies.json` | 44 competencies, real DAG (`prerequisites[]`) | grammar only — no "express an opinion" |
| `content/exam/tcf-canada.json` + `nclc-bands.json` | exam structure and IRCC bands | not connected to what's being taught |
| `content/resources/toolbox.json` | resources by environment/skill/CLB band | selection is by CLB band alone, not by what you're learning |

Four vocabularies, joined only by loose `codes[]` strings. Nothing can answer *"what am I currently building,
and which of these four things serve it?"*

### 2.2 The fix: a Module is the join

A **module** is one durable capability. It is the only object the selector reasons about, and it points at all
four existing artifacts.

`content/curriculum/modules.json`:

```jsonc
{
  "id": "FN_OPINION",
  "family": "functional",          // foundation | functional | comprehension | production | exam | immersion
  "name": "Expressing an opinion",
  "can_do": "State a position on a familiar topic, give two reasons and an example, and answer a disagreement.",
  "clb_band": [4, 7],
  "requires": ["FN_DESCRIBE_ROUTINE", "FN_GIVE_REASON"],   // module-level prerequisites (advisory, see 2.4)
  "competency_codes": ["CNJ_OPPOSITION", "CNJ_CAUSE", "MOOD_SUBJ_PRES"],  // → grammar grid
  "units": [22, 23, 31],           // → beginner ladder units that serve it
  "skills": ["speaking", "writing"],   // the ONLY skills this module is assessed in
  "exam_tasks": ["tcf_s3", "tcf_w3"],  // → exam model
  "environments": ["seated", "driving"],
  "resources": ["innerfrench", "rfi_jff"]   // → toolbox, for immersion selection
}
```

Six families, matching the goal (real French ability, not just exam performance):

- **foundation** — sounds, articles, core verbs, negation, questions, number
- **functional** — introduce yourself, ask for something, explain a problem, complain, compare, give an opinion
- **comprehension** — announcements → familiar dialogue → narrative → opinion → inference → fast/multi-speaker
- **production** — describe → narrate → explain → argue → write structured text → formal register
- **exam** — the TCF task formats themselves, from the official structure, never invented
- **immersion** — authentic material attached to a competency, not served at random

The existing 40 units don't get thrown away: each unit gets a `module_id`, so the beginner ladder becomes the
*first traversal* of the module graph rather than a parallel curriculum.

### 2.3 The graph

`requires` + the competency DAG together form one acyclic graph. A module is **unlocked** when every
`requires` module is at `competent` or better in at least one skill, and every `competency_code` is ≥60%
mastery. The **frontier** is the set of unlocked, non-mastered modules — that is the selector's search space.

### 2.4 Honest caveat: prerequisites will be wrong

An LLM-authored prerequisite graph will contain mistakes, and a wrong edge deadlocks the learner. So:
prerequisites are **advisory**. If a module's `competency_codes` are all ≥ competent but a named `requires`
module is not, the selector may unlock it anyway and writes an `override` row. Deadlock is a worse failure than
a slightly out-of-order module.

---

## 3. Learner model

Five stores. Four exist.

### 3.1 Skill estimates — `skill_estimates` ✅
Four CLB numbers with confidence, one row per recompute (keeps the trend). Coarse but real.

### 3.2 Grammar mastery — `grammar_competencies` / `grammar_mastery` / `grammar_evidence` ✅
Recency- and weight-weighted accuracy over the last 40 observations, shrunk toward 50% on thin evidence,
decayed 1%/day after 10 days idle. This is the best-engineered part of the system and needs no change.

### 3.3 Retention ledger — `cards` / `review_log` / `fsrs_params` ✅
Full FSRS-4.5. Already applies beyond vocabulary (`kind`: vocab | phrase | grammar | question_form |
pronunciation | error).

### 3.4 Error log — `error_patterns` + `grammar_evidence` ⚠️
The data is captured. **The trigger is missing**: nothing acts on "you've made this mistake three times."
See §4, priority 2.

### 3.5 Capability matrix — **MISSING** ⛔

This is the piece your document (§6) is actually asking for and the code has no equivalent of. Today
"lesson 12 passed" is the only progress signal, and "passed the check" ≠ "can do this while speaking."

```sql
CREATE TABLE module_state (
  module_id       TEXT NOT NULL,
  skill           skill NOT NULL,            -- only skills listed in the module
  state           TEXT NOT NULL DEFAULT 'unseen',
                  -- unseen | introduced | practicing | competent | retaining | mastered | maintenance
  score           NUMERIC(3,2) NOT NULL DEFAULT 0,   -- 0..1, same estimator as grammar_mastery
  confidence      NUMERIC(3,2) NOT NULL DEFAULT 0,
  evidence_count  INT NOT NULL DEFAULT 0,
  exam_evidence_count INT NOT NULL DEFAULT 0,
  first_competent TIMESTAMPTZ,
  last_evidence   TIMESTAMPTZ,
  next_probe      TIMESTAMPTZ,
  PRIMARY KEY (module_id, skill)
);
```

**Derived, never written by hand.** Recomputed from evidence already being collected, filtered to the module
by `competency_codes` ∪ `units` ∪ `exam_tasks`:
`grammar_evidence` · `unit_checks` · `submissions` · `quiz_results` · `exam_evidence` · `review_log`.

Transitions are deterministic so the model is auditable:

| → state | condition |
|---|---|
| `introduced` | taught at least once, <3 observations in this skill |
| `practicing` | ≥3 observations, score < 0.70 |
| `competent` | score ≥ 0.70 over ≥5 observations **in this skill** |
| `retaining` | competent, plus ≥1 correct observation ≥14 days after `first_competent` |
| `mastered` | score ≥ 0.85, ≥8 observations, ≥2 exam-format, spread ≥21 days |
| `maintenance` | mastered and no evidence for 30 days → schedule a probe (never decay silently) |
| ↓ demote | score falls a full band below the state's floor → back one state, log it as a regression |

This is what makes the read you asked for possible:

```
FN_PAST_NARRATIVE   grammar  mastered     (0.91, 14 obs)
                    writing  competent    (0.74,  6 obs)
                    speaking practicing   (0.52,  4 obs)   ← the bottleneck
```

**Sizing check.** 40 modules × 4 skills = 160 cells, but 2h/day for 6 months yields only ~4,000 observations —
25 per cell, too thin to be trustworthy. Hence `skills[]` on the module: a cell exists **only** for skills the
module declares (typically 2). ~80 cells, ~50 observations each. The matrix is sparse **by design**; do not
widen it.

### 3.6 Exam readiness — `exam_evidence` / `v_exam_readiness` / `lib/nclc.ts` ✅
Already separates *AI estimate* / *test-backed* / *mock-validated* and never blends them. Keep exactly as is.

---

## 4. The Selector — the missing core

`lib/select.ts`, a pure function over a snapshot:

```ts
select(state: LearnerState, env: Environment, minutes: number, now: Date): Activity[]
```

No network, no LLM, no side effects → unit-testable, reproducible, and **works when Gemini is rate-limited**.
It emits *intents*; §5 authors them.

Priority ladder, evaluated in order until `minutes` is filled:

**1 · Retention dues.** FSRS `due_now`, capped per environment (driving/micro → audio recall; seated → typed).
Never skipped: a forgotten thing is cheaper to fix today than to relearn in month five.

**2 · Error remediation.** Any `error_pattern` with `count ≥ 3` since its last remediation, or any competency
at `regressed`, or any `module_state` that demoted. Emits **one** targeted micro-drill, stamps `remediated_at`
so it can't loop. Capped at one per session — remediation that crowds out progression is its own failure mode.

**3 · Retention probes.** Modules in `maintenance` past `next_probe`. Three items. Turns `mastered` from a
label into a claim that keeps being tested.

**4 · Module progression.** Take the frontier (§2.3). Score each candidate:

```
priority = exam_weight × (1 − score) × clb_proximity × environment_fit × staleness
```

Pick the module, then pick **the weakest skill in that module that the current environment can assess** —
this is the mechanism behind "same module, different lesson." A module whose grammar is strong and whose
speaking is weak gets a speaking activity, not another grammar brief.

**5 · Exam calibration floor.** A minimum share of *seated* time in true TCF format, by month:
`m1–2: 0% · m3: 10% · m4: 20% · m5: 35% · m6: 60%`. This is why exam evidence accrues from day one instead
of being bolted on in month five, and it is a **floor**, not a cap.

**6 · Immersion.** Fill leftover minutes with authentic material from the frontier module's `resources`,
inside the learner's CLB band ±1, wrapped as a sequence (listen → find the position → mine 5 expressions →
comprehension → say your own). Never served raw.

**The selector also explains itself.** Every emitted activity carries `{ why, module_id, skill, priority_rule }`,
which is what the morning card, `/why`, and the weekly review render. No LLM narration needed for the rationale.

---

## 5. Environment router

**Today the environment is inferred from the clock** (`learner.schedule`: patrol 08:00, driving 15:15,
seated 17:30). Shifts move; the clock is wrong often enough to break trust in the queue.

**Add `/now`** → four buttons (🚶 walking · 🚗 driving · 🪑 seated · ⏱ 2 minutes) → sets the active environment
for 90 minutes → the pump serves `select(state, env, remaining)`. The clock schedule survives as the *default*
when no mode is declared. One tap, and the "what should I do right now" question is gone for good.

Environment affordances (what a mode can *assess*, which is what constrains the selector):

| env | can deliver | can assess |
|---|---|---|
| walking / patrol | audio, lesson, shadowing | spoken recall, post-hoc typed check |
| driving | audio only, prompt→pause→answer | spot check after the drive |
| micro | 8–15 typed cards, one sentence | typed recall |
| seated | anything | everything, incl. exam-format |

---

## 6. Pacing engine

`content/curriculum/macro.json` — six months, each with: target NCLC per component, required module set,
exam-format ratio, and a gate.

| Month | Focus | Gate to advance |
|---|---|---|
| 1 | Sounds, high-frequency vocabulary, present, questions, negation | 12 foundation modules ≥ competent |
| 2 | Daily life, passé composé, futur proche, practical interaction | listening NCLC 3, 10 functional modules |
| 3 | Narration, description, explanation, connectors, imparfait | speaking NCLC 4, first exam-format items |
| 4 | Opinion, comparison, argument, hypothetical, formal register | writing NCLC 5, 20% seated in exam format |
| 5 | B2 comprehension, structured speaking/writing, TCF formats | all four components NCLC 5, one full section mock |
| 6 | Timed mocks, remediation, calibration | NCLC 7 test-backed on ≥3 components |

Weekly, `lib/pace.ts` compares module coverage against the month's required set and takes **one bounded
action**: raise the new-module rate, extend the month, or drop modules marked optional. It never silently
drifts, and it always says which of the three it did.

---

## 7. Gemini's contract

| Role | Allowed to | Never |
|---|---|---|
| AUTHOR | write a lesson/drill/task for a given (module, skill, environment, minutes, known-material) | choose the module |
| EXAMINER | write check items from material already met | decide whether progress happened |
| GRADER | score, correct, and emit `{competency_code, correct, weight}` evidence rows + a CLB sub-score | write to `module_state` directly |
| TUTOR | explain a miss, answer a French question | change the plan |
| CURATOR | pick authentic content for a module + band | invent the curriculum |

Note there is **no PLANNER role** in the target architecture. `lib/planner.ts`'s prompt currently holds ~40
lines of scheduling policy; that policy moves into `lib/select.ts` as code. This kills the biggest quota risk
(one LLM call before anything can be delivered) and makes the day reproducible.

---

## 8. Build order

Each phase is shippable on its own and none of them break the running bot.

**Phase 0 — make the learner model visible** *(no behaviour change)*
`content/curriculum/modules.json` (40 modules covering the 6 families, `module_id` back-filled onto the 40
ladder units) · `module_state` table · `lib/modules.ts` (recompute from existing evidence, run nightly) ·
`/state` command rendering the module × skill matrix.
→ *Unblocks everything else. You can see what the system thinks you can do.*

**Phase 1 — `/now` environment router**
Serve the current plan by declared environment instead of by clock.
→ *Immediate daily benefit, zero new model needed.*

**Phase 2 — the selector**
`lib/select.ts` with priorities 1, 4, 5. `beginnerPlan()` and `buildPlan()` both become thin wrappers over it;
the PLANNER prompt is deleted. Snapshot tests on a seeded database.
→ *The day becomes deterministic and quota-proof.*

**Phase 3 — remediation and probes** *(needs ~2 weeks of real error data)*
Priorities 2 and 3. Nothing to build against until the error log has content.

**Phase 4 — pacing engine**
`macro.json`, `lib/pace.ts`, exam-format floor wired into the selector, weekly pace line in the review.

**Phase 5 — immersion**
Priority 6: CURATOR role, content sequencing, resource attachment by module.

---

## 9. What we are deliberately not doing

- **No redesign of what works.** Delivery, TTS batching, FSRS, the grammar grid, the teach→practice→check
  lesson shape, and the NCLC readiness split are correct and stay untouched.
- **No second competency vocabulary.** Modules point at the existing 44 grammar codes; they do not replace them.
- **No wider capability matrix.** Sparse by design (§3.5).
- **No LLM in the selection path.** Authoring and grading only.
- **No self-report progress.** State changes only through checks the bot administers.

---

# Part II — learning flow and resource plumbing

Part I settled *who chooses*. This part settles *what arrives*: how input precedes output, where content comes
from without manual data entry, and how retention rides alongside progression instead of fighting it.

---

## 10. Input before output — killing the interrogation trap

### 10.1 The real diagnosis

`lib/teach.ts` already does teach → practice → check, and it does it well. But it only exists **for lesson
units**. Every other activity the bot can send is output-first:

| activity | input phase today |
|---|---|
| lesson unit | ✅ teach → guided practice → check |
| FSRS card, first ever sight of it | ❌ "Type the French" for a word you have never seen |
| driving drill | ❌ prompt → pause → answer, cold |
| drill spot check | ❌ pure recall |
| grammar brief | ⚠️ explanation, then straight to a test |
| listening / reading set | ❌ comprehension questions, no pre-teaching |
| `/fr` say-it-in-French | ❌ produce, then get corrected |

Six of seven paths demand output first. That is the interrogation feeling, and it is not a tone problem — it is
a **missing phase in the activity contract**.

### 10.2 The contract: three phases, or say why not

The selector stops emitting "items" (`{type:"drill"}`) and starts emitting **activities** with a fixed shape:

```ts
// lib/activity.ts
export type Activity = {
  module_id: string;
  skill: Skill;
  env: Environment;
  minutes: number;
  why: string;                         // the selector rule that produced this — rendered to you
  phases: {
    input:   InputSpec | { skip: "already_met"; evidence: number };  // ← must be justified, not omitted
    guided:  GuidedSpec;               // supported, hints on, NOT scored, NO evidence written
    produce: ProduceSpec;              // scored, writes grammar_evidence + exam_evidence
  };
};

export type InputSpec =
  | { kind: "audio_snippet";  text_fr: string[]; gloss_en: string[]; repeats: 2 }
  | { kind: "text";           body_fr: string; unknown_budget: number }
  | { kind: "breakdown";      rule_en: string; worked: { fr: string; en: string; note: string }[] }
  | { kind: "worked_example"; fr: string; en: string; walkthrough: string };
```

`input.skip` is allowed **only** with evidence attached, and the evidence is checked in code (§10.3). An
activity that cannot justify skipping input gets one generated. This is the whole fix: the shape of the object
makes the interrogation impossible to express.

### 10.3 The exposure ledger — the gate that enforces it

You cannot be tested on something you have not met. Today nothing records "met"; `grammar_evidence` only
records *performance*. So:

```sql
-- Every time material is PRESENTED to you (not tested). The counterpart to grammar_evidence.
CREATE TABLE IF NOT EXISTS exposures (
  id          SERIAL PRIMARY KEY,
  target_kind TEXT NOT NULL,          -- competency | card | module | pattern
  target_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- audio | text | breakdown | worked_example | dialogue
  source_type TEXT, source_id INT,
  env         environment,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_12_exposures ON exposures (target_kind, target_id, created_at DESC);
```

And one hard gate in the selector:

```ts
// lib/activity.ts — called on every produce phase before it is emitted
const MIN_EXPOSURES = 2;
const WINDOW_DAYS   = 21;

export async function gateInput(a: Activity): Promise<Activity> {
  const targets = produceTargets(a);                    // competency codes + card ids the produce phase touches
  const cold: string[] = [];
  for (const t of targets) {
    const n = await one`SELECT COUNT(*)::int AS n FROM exposures
                        WHERE target_kind = ${t.kind} AND target_id = ${t.id}
                          AND created_at > now() - (${WINDOW_DAYS} || ' days')::interval`;
    if (Number(n?.n ?? 0) < MIN_EXPOSURES) cold.push(t.id);
  }
  if (!cold.length) return a;                            // met recently enough — produce as planned
  return { ...a, phases: { ...a.phases, input: await buildInput(a, cold) } };   // demote: teach it first
}
```

Two consequences worth stating plainly: **a produce phase can never target cold material**, and **guided
phases write exposures, never evidence** (that rule already holds in `teach.ts`'s practice step — it becomes
universal).

### 10.4 What "input" is, per environment

Input is not a lecture. It is the smallest amount of *comprehensible French* that makes the following
production possible.

| env | input phase | length |
|---|---|---|
| patrol / walking | 6–8 natural sentences carrying the pattern, French → English gloss → French again, one voice note | 60–90s |
| driving | same, but the pattern is *modelled answered* three times before the first prompt — Michel Thomas order, not Pimsleur cold-call | 90s |
| seated | a 100–140 word text at i+1 containing the pattern ≥4 times, then a ≤120-word breakdown with 3 worked examples | 3–4 min |
| micro | one **worked example card**: front shows the problem *already solved*, you read it and type it while visible | 20s |

### 10.5 The card fix — a new card's first sight is not a test

`srs.ts::pickQueue` mixes `state = 'new'` cards into the same session as reviews, and `sendCard` asks you to
type the French for a word you may never have seen. That single behaviour is a large share of the
interrogation feeling.

```ts
// lib/srs.ts — sendCard, new branch
if (c.state === "new" && !c.introduced_at) {
  // PRESENTATION, not retrieval: show both sides + audio, ask for a copy-typed repetition.
  await sendMessage(chatId, `🆕 <b>${esc(c.front)}</b>\n➡️ <b>${esc(c.back)}</b>\n<i>Type it once, exactly.</i>`);
  await sendVoiceById(chatId, await cardAudio(c), "");
  await sql`UPDATE cards SET introduced_at = now() WHERE id = ${c.id}`;
  await logExposure("card", String(c.id), "worked_example", c.id);
  // copy-typing is motor encoding, not recall: it is graded 'good' and enters FSRS as learning, never 'again'
}
```

Requires one column: `ALTER TABLE cards ADD COLUMN IF NOT EXISTS introduced_at TIMESTAMPTZ;`

---

## 11. Resource plumbing — where content comes from

The honest constraint first: **there is no clean API for most authentic content.** Manga text, most YouTube
transcripts, and paywalled news are either unavailable, fragile to scrape, or not ours to redistribute. Any
architecture that assumes "the system finds the perfect native clip" will be a permanent source of breakage.

So content comes from three tiers, and the volume deliberately sits in the middle one.

### 11.1 Tier A — indexed feeds (data entry: zero, already half-built)

`resources.feed_url` and `units.ts::ingestLatestEpisode` already exist. The change is **index, don't just
fetch the latest**: a nightly job walks each feed, stores every new item as a `resource_unit`, and classifies
it once.

```sql
ALTER TABLE resource_units ADD COLUMN IF NOT EXISTS topics     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE resource_units ADD COLUMN IF NOT EXISTS module_fit TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE resource_units ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_13_units_fit ON resource_units USING GIN (module_fit);
```

```ts
// api/cron/index-feeds.ts — one CURATOR call per NEW item, ever. Not per lesson, not per day.
for (const item of await newFeedItems(resource)) {
  const c = await ask<{ modules: string[]; clb: number; topics: string[]; usable: boolean }>("CURATOR",
    `French audio item. Title: ${item.title}. Description: ${item.desc.slice(0, 1200)}.
     Modules available: ${MODULE_INDEX.map(m => `${m.id}=${m.can_do}`).join("; ")}.
     Return {"modules":[ids this genuinely practises],"clb":1-12,"topics":[3-6],"usable":false if it is
     music, an ad, or has no speech}.`, { temperature: 0.2 });
  if (c.usable) await sql`UPDATE resource_units SET module_fit = ${c.modules}, topics = ${c.topics},
                          clb_level = ${c.clb}, indexed_at = now() WHERE id = ${item.id}`;
}
```

The library grows on its own and each item is paid for once. Feeds that actually work and publish transcripts:
**RFI Journal en français facile**, **InnerFrench**, **Français Authentique**, **Radio-Canada** feeds,
**Wikipédia FR** (open API, good for reading at any level). That list is short on purpose — it is what is
reliably fetchable, not what would be nice.

### 11.2 Tier B — generated i+1 material (the workhorse)

For most modules the ideal input does not exist as a native artefact anyway: you need a text at *your* exact
level, about *your* life, that hits *this* pattern six times. That is a generation problem, and generation has
no data entry by definition.

The thing that makes generated content trustworthy is a **deterministic quality gate**, not a better prompt:

```ts
// lib/lexicon.ts — the learner's known lexicon, from what has actually been presented
export async function knownLexicon(): Promise<Set<string>> {
  const rows = await sql`
    SELECT back AS t FROM cards WHERE NOT suspended AND (state <> 'new' OR introduced_at IS NOT NULL)
    UNION ALL SELECT jsonb_array_elements(payload->'dialogue')->>'fr' FROM resource_units
      WHERE status IN ('attempted','passed','mastered')`;
  const s = new Set<string>();
  for (const r of rows) for (const w of tokenise(r.t)) s.add(w);
  for (const w of TOP_500_FR) s.add(w);          // corpus floor: assume the 500 commonest lemmas
  return s;
}

export function unknownRatio(text: string, known: Set<string>) {
  const toks = tokenise(text);
  const unknown = toks.filter(w => !known.has(w));
  return { ratio: unknown.length / Math.max(1, toks.length), unknown: [...new Set(unknown)] };
}
```

```ts
// lib/resource.ts — generate, then MEASURE. Regenerate against the measurement, not against a vibe.
export async function generateInput(module: Module, clb: number, kind: "text" | "audio_snippet") {
  const known = await knownLexicon();
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await ask<{ body_fr: string }>("AUTHOR", inputPrompt(module, clb, kind, attempt));
    const { ratio, unknown } = unknownRatio(draft.body_fr, known);
    if (ratio <= 0.10) return { ...draft, unknown };            // i+1: ≤10% new, the rest known
    if (attempt === 2) return { ...draft, unknown: unknown.slice(0, 8), degraded: true };
  }
}
```

**Every generated input is stored as a `resource_unit`** under a `generated` resource, tagged with its
`module_fit`. It is therefore reusable, re-scheduleable, gate-checkable and cacheable exactly like an Assimil
lesson. The library builds itself as you use it — that is the answer to the data-entry nightmare.

### 11.3 Tier C — registered sources (data entry: once per source, never per item)

The existing `content/resources/toolbox.json`. A row per *source* (Assimil PDF, a YouTube channel, a textbook),
never a row per item. Already built, no change.

### 11.4 The selection function

```ts
// lib/resource.ts — deterministic, with generation as the fallback, never a live web call at delivery time
export async function resourceFor(m: Module, skill: Skill, env: Environment, minutes: number) {
  const clb = await clbFor(skill);
  const hit = await one`
    SELECT * FROM resource_units
     WHERE ${m.id} = ANY(module_fit) AND status = 'unseen'
       AND clb_level BETWEEN ${clb - 0.5} AND ${clb + 1.5}
       AND (skills && ${[skill]}::skill[])
     ORDER BY ABS(clb_level - ${clb}), indexed_at DESC LIMIT 1`;
  if (hit) return hit;                                   // Tier A: an indexed real item fits
  return cacheAsUnit(m, await generateInput(m, clb, env === "driving" ? "audio_snippet" : "text"));
}
```

Note what is absent: no live search, no scraping, no fetch at delivery time. Delivery reads the database;
ingestion and generation happen on the nightly cron where latency and quota failures are harmless.

---

## 12. How FSRS actually hooks into the loop

Three separate questions get conflated here — *when do reviews happen*, *do they steal progression time*, and
*do they feed the module model*. They have three different answers.

### 12.1 Reviews get a budget, not the whole session

Rule 1 of the selector is capped per environment, so a review backlog can never eat a module day:

```ts
// lib/select.ts
const DUE_BUDGET: Record<Environment, number> = {
  micro:   1.0,     // a micro slot is entirely cards
  driving: 0.35,    // audio-answerable cards folded into the drill's prompt stream
  patrol:  0.20,
  seated:  0.25,    // never more than a quarter of a focused block
};
const dueMinutes = Math.floor(minutes * DUE_BUDGET[env]);
```

### 12.2 The backlog governor — the Anki death spiral, prevented in code

When you fall behind, the wrong response is to serve more cards; it is to stop making new ones. Today
`new_cards_per_day` is a fixed setting. It becomes a function of the backlog:

```ts
// lib/srs.ts — replaces the fixed learner.settings.new_cards_per_day read in pickQueue()
export async function newCardBudget(): Promise<number> {
  const l = await one`SELECT due_now, due_tomorrow FROM v_fsrs_load`;
  const backlog = Number(l?.due_now ?? 0) + Number(l?.due_tomorrow ?? 0);
  const absorbable = 60;                                   // reviews/day 2h of study can actually absorb
  const cap = Number((await getLearner()).settings?.new_cards_per_day ?? 20);
  return Math.max(0, Math.round(cap * (1 - backlog / (absorbable * 2))));
}
```

At a backlog of 120 the intake is 0; at 60 it is half; at 0 it is the full 20. Self-correcting, no dial to
watch.

### 12.3 Retention *feeds* module progression — it does not compete with it

This is the part that answers "without breaking module progression." Cards get a module:

```sql
ALTER TABLE cards ADD COLUMN IF NOT EXISTS module_id TEXT;
CREATE INDEX IF NOT EXISTS ix_14_cards_module ON cards (module_id) WHERE NOT suspended;
```

and `module_state` reads FSRS stability as its **retention dimension** — which is what makes the `retaining`
and `mastered` states mean something rather than being a label applied on the day you happened to score well:

```sql
-- component of module_state.score, recomputed nightly by lib/modules.ts
SELECT AVG(LEAST(1.0, stability / 21.0)) AS retention
  FROM cards
 WHERE module_id = $1 AND NOT suspended AND state <> 'new';
```

Gate: **a module cannot enter `retaining` while its cards average under 14 days of stability**, no matter how
well you scored on its check. Performance and durability are different claims and the model keeps them apart.

### 12.4 Lapses are a remediation trigger, not just a reschedule

FSRS reschedules a lapsed card. It does not ask *why* you keep forgetting it. That bridge is missing today:

```ts
// lib/srs.ts::applyRating, after the review_log insert
if (rating === 1 && c.lapses + 1 >= 3) {
  await sql`INSERT INTO error_patterns (category, kind, example, count)
            VALUES (${"leech:" + (c.competency_code ?? c.front)}, 'lexis', ${c.back}, 1)
            ON CONFLICT (category) DO UPDATE SET count = error_patterns.count + 1, last_seen = now()`;
}
```

Selector rule 2 then picks it up and emits an **input-phase re-teach** of that item — a worked example, the
word in three new contexts, audio — instead of showing you the same failing card a fourth time. A leech is a
teaching failure, not a memory failure.

### 12.5 Environment mapping for due cards

`cards.answer_mode` (typed | self_rated | voice) already exists; the routing rule is:

| env | which due cards | how answered |
|---|---|---|
| micro | any typed card | typed in Telegram |
| driving | `kind` in (phrase, pronunciation, question_form), folded into the drill's TTS stream | aloud; verified at the post-drive spot check |
| patrol | audio prompt, self-rated | tap |
| seated | typed, plus every leech with its ❓ Why? | typed |

### 12.6 Already correct, don't touch

Interval capping at the exam horizon (`srs.ts::params()`), the full `review_log` for later weight
optimisation, `recordEvidence` firing on every card review that carries a `competency_code`, and the
`srs_deferred` arbitration in `flow.ts` that stops cards interrupting a running check.

---

## 13. Revised build order

Part II changes the order: the input gate is worth more than the selector, because it fixes what the daily
experience *feels* like, and it is smaller.

| Phase | Work | Why here |
|---|---|---|
| **P0** | `modules.json`, `module_state`, `lib/modules.ts`, `/state` | nothing else can be built against an invisible model |
| **P0.5** | `exposures` table · `cards.introduced_at` · new-card presentation step · `gateInput()` | **the interrogation fix — smallest change, biggest daily difference** |
| **P1** | `/now` environment router | stops the clock guessing your shift |
| **P1.5** | `lib/lexicon.ts` + `generateInput()` + `resource_units.module_fit` + the feed indexer | input phases need something to be made of |
| **P2** | `lib/select.ts` (rules 1, 4, 5) · delete the PLANNER prompt · `DUE_BUDGET` + `newCardBudget()` | the day becomes deterministic and quota-proof |
| **P3** | rules 2 and 3: leech → remediation, maintenance probes | needs ~2 weeks of real error data |
| **P4 / P5** | pacing engine · immersion selection | last, and cheapest once the rest exists |
