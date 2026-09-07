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
