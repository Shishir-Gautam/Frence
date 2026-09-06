# french-bot v2 — Polyglot Coach for TCF Canada · CLB 7

A single-learner Telegram coach. A nightly **planner** reads your learner model (44-competency grammar grid, FSRS load, resource toolbox, graded history) and routes tomorrow's work across your three environments — **patrol** (active input), **driving** (prompt→pause→answer audio drills), **seated** (grammar + TCF output). Every unit ends in a **gate check** the bot authors and scores; every drive ends in a **spot check**; every writing/speaking task gets a **CLB sub-score (1–12)** from the TCF rubric; every correction becomes **weighted grammar evidence** that moves the mastery grid the planner reads the next night. Nothing advances on self-report.

Stack: Telegram · Vercel functions (TypeScript) · Gemini 3.x Flash (planning, examining, grading, TTS) · Postgres (Neon).

## Layout

```
api/telegram.ts           webhook: commands, buttons, typed answers, voice notes
api/cron/plan.ts          nightly planner (Vercel cron)
api/cron/push.ts          delivery pump (ping every 10 min)
api/cron/weekly.ts        Sunday review
api/setup.ts              apply schema + seed toolbox & grid + register webhook (re-runnable)

lib/coach.ts              Gemini gateway: one system prompt, roles PLANNER / DRILL AUTHOR / EXAMINER / GRADER / TUTOR
lib/coach-prompt.ts       generated from content/prompts/polyglot-coach.system.md
lib/planner.ts            snapshot -> plan (validated against NEXT UNITS / TEACHABLE) -> timed deliveries
lib/deliver.ts            renders slots: morning card, units, drills, grammar briefs, TCF tasks, check-in
lib/units.ts              resource router runtime: Assimil lessons + RSS episodes, gate-check hand-off
lib/drills.ts             DRILL AUTHOR -> script -> one MP3 -> post-drive spot check
lib/tts.ts                Gemini TTS -> MP3 (lamejs), segment cache, silence gaps, drill assembly
lib/checks.ts             check engine: typed / MCQ / dictation / voice items -> score, evidence, cards, status
lib/generate.ts           TCF listening/reading sets, writing & speaking tasks, multi-turn interview, grammar brief
lib/grade.ts              GRADER -> submissions.clb_sub, criteria, corrections -> evidence, error cards, skill estimate
lib/grammar.ts            evidence -> mastery recompute (recency & weight, shrinkage, decay) -> teachable()
lib/fsrs.ts + srs.ts      FSRS-4.5 (params from DB), typed-answer cards, review_log
lib/answer.ts             accent-insensitive answer checking with an "almost" tier
lib/progress.ts           /progress, weekly report, placement estimate
lib/seed.ts               schema + toolbox + grid seeding
db/schema.sql             21 tables + 3 views (see comments)
content/exam/tcf-canada.json         exam model
content/grammar/competencies.json    the 44-competency grid
content/resources/toolbox.json       the resource toolbox (environments, CLB bands, cadence, feeds)
content/prompts/polyglot-coach.system.md
scripts/smoke.ts          end-to-end test with Gemini + Telegram mocked (runs against any Postgres)
```

## Setup

1. @BotFather → `/newbot` → token. Gemini key from AI Studio. Neon project → connection string.
2. Push to a private GitHub repo → import in Vercel → paste `.env.example` variables → deploy.
3. Open `https://<app>.vercel.app/api/setup?key=<CRON_SECRET>` once: applies schema, seeds 10 resources + 44 competencies, sets webhook + command menu.
4. Locally (`.env` filled):
   ```
   npm i
   npm run assimil:chunk -- /path/to/french-with-ease.pdf   # Gemini reads the PDF, writes content/assimil/lessons.json
   npm run assimil:load                                     # -> resource_units (resource 'assimil')
   npm run seed:cards                                       # ~300 starter cards tagged to grid codes
   ```
5. Scheduler: Vercel Hobby cron runs once a day, so the planner is on Vercel cron (`vercel.json`) and the pump needs an external pinger — on cron-job.org:
   - every 10 min → `GET https://<app>.vercel.app/api/cron/push?key=<CRON_SECRET>`
   - Sundays 20:00 Toronto → `GET https://<app>.vercel.app/api/cron/weekly?key=<CRON_SECRET>`
6. In Telegram: `/start` → `/placement` (12 items, sets your starting CLB) → `/today`.

## A day (defaults in `learner.schedule`)

| time | environment | what happens |
|---|---|---|
| 06:30 | — | morning card: focus, slots, buttons to start any slot early |
| 08:00 / 11:00 | patrol | Assimil lesson — or, until Assimil is loaded / you reach CLB 3, a bot-authored beginner lesson from a 16-step survival ladder — (text + 🐢/🐇 voice notes) → **Check me**: back-translation, dictation, transform, MCQ (80% to pass; misses become cards, fails come back tomorrow). Exam-style listening/reading sets only from CLB 3. |
| 10:00 / 13:00 / 19:30 | micro | FSRS cards, **typed** — the bot checks the answer, maps it to Again/Hard/Good/Easy, reschedules |
| 15:15 | driving | one MP3 drill (Pimsleur / Michel Thomas / Language Transfer structure) on 1–2 grid competencies, recycling due cards → **Spot check** (5 prompts) at the next micro slot |
| 17:30 | seated | grammar brief + 6-item typed test (≤2 competencies), writing task (reply text), speaking task / multi-turn interview (reply voice), reading set — delivered **one item at a time**; the next arrives when the current one is scored (or ⏭ Next item) |
| 21:30 | — | check-in: verified vs reported minutes, slots completed |
| 22:30 | — | planner: decay grid, refresh estimates, write tomorrow |
| Sun | seated | surprise retention test from the last 3 weeks + weekly review |

Any time: `/drill CODE [pimsleur|michel_thomas|language_transfer]`, `/grammar CODE`, `/interview s1|s3`, `/write w3`, `/speak s2`, `/listen`, `/read`, `/review`, `/progress`, `/codes`, `/ping`. `/next` moves the slot on, `/skip` abandons the current item or test.

Only one interactive thing runs at a time: a check pauses an open card session; a card slot that lands mid-check is queued and starts when the check ends. An untaken post-drive spot check runs at the next card slot. Re-planning during the day never re-sends slots that already went out.

## How the numbers move

- **CLB per skill** — writing/speaking: recency-weighted mean of the last 6 `clb_sub` (GRADER, calibrated by the rubric in the system prompt); listening/reading: highest item CLB with ≥70% on ≥4 items in 21 days. History in `skill_estimates`.
- **Grammar mastery** — every graded task, check item and competency-tagged card writes `grammar_evidence` (correct *and* incorrect uses; weight 1.0 production, 0.8 typed check, 0.6 dictation, 0.5 card, 0.4 MCQ). `mastery_pct` = recency-weighted accuracy over the last 40 observations, shrunk toward 50% while evidence is thin, −1%/day after 10 days without evidence. `v_grammar_weakest` ranks by `exam_weight × (100 − mastery)`; `teachable()` filters to competencies whose prerequisites are ≥60%.
- **Typed answers** — accent/case-insensitive; a typo-level miss counts as "almost" for vocabulary but as **wrong** for any grammar-tagged item (a wrong ending *is* the error) and for dictation.
- **FSRS** — FSRS-4.5, weights in `fsrs_params` (optimise later from `review_log`), intervals capped at the exam date.

## Testing

`npm run smoke` with `DATABASE_URL` pointing at any Postgres runs the whole loop with Gemini and Telegram mocked: seeding, placement, evidence → mastery → teachable, typed cards → review_log, planner → 8 deliveries, patrol delivery → gate check → unit passed, drill authoring → MP3 render → spot check, grammar test → evidence, writing grading → clb_sub → estimate → error card, progress card.

## Cost

Per day ≈ 1 planner call (~15–25k tokens in), 4–8 EXAMINER/GRADER calls, 1 DRILL AUTHOR call, and TTS for new segments only (drill prompts/answers and lesson audio are cached by hash / Telegram file_id). Comfortably inside Gemini's free tier for one learner.
