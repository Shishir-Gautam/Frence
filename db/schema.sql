-- ============================================================================
-- french-bot v2 — Polyglot Coach learner model (Postgres / Neon)
-- Multi-resource router · FSRS-4.5 · grammar mastery grid · CLB sub-score tracking
-- Single learner (one Telegram chat). All times TIMESTAMPTZ; local schedule in learner.tz.
-- ============================================================================

DO $$ BEGIN
  CREATE TYPE environment AS ENUM ('patrol', 'driving', 'seated', 'micro');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE skill AS ENUM ('listening', 'reading', 'writing', 'speaking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE card_state AS ENUM ('new', 'learning', 'review', 'relearning');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- learner --
CREATE TABLE IF NOT EXISTS learner (
  id              INT PRIMARY KEY DEFAULT 1,
  chat_id         BIGINT,
  tz              TEXT NOT NULL DEFAULT 'America/Toronto',
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  exam_date       DATE,
  target_clb      INT  NOT NULL DEFAULT 7,
  placement_done  BOOLEAN NOT NULL DEFAULT FALSE,
  -- environment windows the planner fills (local HH:MM). srs = list of micro slots.
  schedule        JSONB NOT NULL DEFAULT '{
    "morning_card":"06:30",
    "patrol":["08:00","11:00"],
    "srs":["10:00","13:00","19:30"],
    "driving":"15:15",
    "seated":"17:30",
    "checkin":"21:30"}',
  settings        JSONB NOT NULL DEFAULT '{"new_cards_per_day":20,"target_minutes":150,"drill_pause_seconds":4}',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------ skill estimate history --
-- One row per recompute; latest row per skill = current estimate. Keeps the trend for /progress.
CREATE TABLE IF NOT EXISTS skill_estimates (
  id          SERIAL PRIMARY KEY,
  skill       skill NOT NULL,
  clb         NUMERIC(4,2) NOT NULL,           -- 1.00 .. 12.00
  confidence  NUMERIC(3,2) NOT NULL DEFAULT 0.5, -- 0..1, rises with evidence count
  basis       JSONB,                            -- what it was computed from
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_01_skill_estimates ON skill_estimates (skill, computed_at DESC);

-- ================================================== RESOURCE ROUTER ======
-- The Toolbox. A resource is a source; a unit is one consumable piece (lesson, episode, drill set).
CREATE TABLE IF NOT EXISTS resources (
  id              TEXT PRIMARY KEY,             -- 'assimil', 'innerfrench', 'rfi_jff', 'drill_pimsleur', 'kwiziq_style', 'tcf_gen'
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL,                -- course | podcast | news | drill_generator | grammar_generator | exam_generator | method
  environments    environment[] NOT NULL,       -- where it may be routed
  skills          skill[] NOT NULL,
  clb_min         NUMERIC(4,2) NOT NULL DEFAULT 1,   -- router only picks units whose band overlaps the learner
  clb_max         NUMERIC(4,2) NOT NULL DEFAULT 12,
  modality        TEXT[] NOT NULL,              -- audio | text | interactive
  minutes_per_unit INT NOT NULL DEFAULT 15,
  priority        INT NOT NULL DEFAULT 5,       -- planner tie-breaker, 1 = highest
  cadence_rule    TEXT,                         -- free text the planner honours: "one unit/day, 6 days/week", "max 3/week"
  url             TEXT,
  feed_url        TEXT,                         -- RSS for podcast/news resources (units ingested on demand)
  how_to_use      TEXT NOT NULL,                -- instructions to the planner / renderer
  active          BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS resource_units (
  id              SERIAL PRIMARY KEY,
  resource_id     TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  seq             INT,                          -- lesson number / episode order
  title           TEXT,
  ref             TEXT,                         -- episode url, page range, etc.
  clb_level       NUMERIC(4,2),                 -- estimated difficulty
  skills          skill[],
  payload         JSONB NOT NULL DEFAULT '{}',  -- assimil: {dialogue:[{fr,en}],notes,exercises}; podcast: {transcript, summary, key_vocab}; news: {headline, transcript}
  audio_slow      TEXT,                         -- telegram file_id caches (synthesised once)
  audio_normal    TEXT,
  status          TEXT NOT NULL DEFAULT 'unseen',  -- unseen | scheduled | attempted | passed | mastered
  attempts        INT NOT NULL DEFAULT 0,
  best_score      NUMERIC(5,2),                 -- % on the gate check
  last_used       TIMESTAMPTZ,
  UNIQUE (resource_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_02_resource_units ON resource_units (resource_id, status);

-- Gate checks: a unit is only 'passed' when the bot's own test says so (no self-report).
CREATE TABLE IF NOT EXISTS unit_checks (
  id              SERIAL PRIMARY KEY,
  unit_id         INT NOT NULL REFERENCES resource_units(id) ON DELETE CASCADE,
  check_type      TEXT NOT NULL,                -- back_translation | dictation | comprehension_mcq | shadow_voice | recall_qna
  items           JSONB NOT NULL,               -- [{prompt, expected, given, correct, competency_code?}]
  score_pct       NUMERIC(5,2) NOT NULL,
  passed          BOOLEAN NOT NULL,
  environment     environment,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================== DRIVING AUDIO DRILLS ======
-- Prompt -> pause -> answer scripts (Pimsleur / Michel Thomas / Language Transfer structure), rendered to one MP3.
CREATE TABLE IF NOT EXISTS drills (
  id              SERIAL PRIMARY KEY,
  method          TEXT NOT NULL,                -- pimsleur | michel_thomas | language_transfer | shadowing
  title           TEXT NOT NULL,
  competency_codes TEXT[] NOT NULL DEFAULT '{}', -- grammar points the drill targets
  vocab_card_ids  INT[] NOT NULL DEFAULT '{}',   -- FSRS cards recycled inside the drill (interleaving)
  clb_level       NUMERIC(4,2) NOT NULL,
  script          JSONB NOT NULL,               -- [{type:"teach"|"prompt"|"answer"|"recap", en?, fr?, pause_s?}] in playback order
  duration_s      INT,
  audio_file      TEXT,                         -- telegram file_id after first render
  times_played    INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- After a drive the bot asks 3-5 of the drill's prompts back as a spot check (typed or voice) -> evidence.
CREATE TABLE IF NOT EXISTS drill_sessions (
  id              SERIAL PRIMARY KEY,
  drill_id        INT NOT NULL REFERENCES drills(id) ON DELETE CASCADE,
  played_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  spot_check      JSONB,                        -- [{prompt, expected, given, correct}]
  score_pct       NUMERIC(5,2),
  self_difficulty INT                           -- 1-4 optional learner rating
);

-- ============================================== GRAMMAR MASTERY GRID =====
CREATE TABLE IF NOT EXISTS grammar_competencies (
  code            TEXT PRIMARY KEY,             -- 'pc_vs_imparfait', 'subj_il_faut_que', 'rel_qui_que_dont', 'question_inversion' ...
  family          TEXT NOT NULL,                -- tense | mood | pronoun | agreement | syntax | connectors | interrogation | negation | determiners
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,                -- what "mastered" means, with 2 example sentences
  clb_needed      INT NOT NULL,                 -- first CLB level where this is expected (drives planner priority)
  exam_weight     INT NOT NULL DEFAULT 3,       -- 1-5 how often TCF writing/speaking task 3 leans on it
  prerequisites   TEXT[] NOT NULL DEFAULT '{}',
  sort_order      INT NOT NULL
);

-- Current mastery per competency. Updated by a function from grammar_evidence (recency-weighted, decays without evidence).
CREATE TABLE IF NOT EXISTS grammar_mastery (
  competency_code TEXT PRIMARY KEY REFERENCES grammar_competencies(code) ON DELETE CASCADE,
  mastery_pct     NUMERIC(5,2) NOT NULL DEFAULT 0,   -- 0-100
  confidence      NUMERIC(3,2) NOT NULL DEFAULT 0,   -- 0-1, from evidence count & spread
  evidence_count  INT NOT NULL DEFAULT 0,
  correct_streak  INT NOT NULL DEFAULT 0,
  last_evidence   TIMESTAMPTZ,
  last_taught     TIMESTAMPTZ,                       -- last grammar brief / drill on it
  status          TEXT NOT NULL DEFAULT 'untouched', -- untouched | introduced | practising | reliable | mastered | regressed
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every observation of a competency, from any source. This is what Gemini writes when it grades.
CREATE TABLE IF NOT EXISTS grammar_evidence (
  id              SERIAL PRIMARY KEY,
  competency_code TEXT NOT NULL REFERENCES grammar_competencies(code) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,                -- submission | unit_check | drill_session | card_review | quiz
  source_id       INT,
  correct         BOOLEAN NOT NULL,
  weight          NUMERIC(3,2) NOT NULL DEFAULT 1.0,  -- free production = 1.0, MCQ = 0.4, card = 0.5
  excerpt         TEXT,                         -- the learner's phrase
  correction      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_03_grammar_evidence ON grammar_evidence (competency_code, created_at DESC);

-- ============================================================ FSRS ========
-- Full FSRS-4.5 state per card; review log kept complete so weights can be optimised later.
CREATE TABLE IF NOT EXISTS fsrs_params (
  id              INT PRIMARY KEY DEFAULT 1,
  weights         NUMERIC[] NOT NULL,           -- 19 weights (w0..w18); seeded with FSRS-4.5 defaults
  request_retention NUMERIC(3,2) NOT NULL DEFAULT 0.90,
  maximum_interval INT NOT NULL DEFAULT 180,    -- days; capped at exam horizon
  optimised_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cards (
  id              SERIAL PRIMARY KEY,
  front           TEXT NOT NULL,                -- EN prompt (or FR audio cue)
  back            TEXT NOT NULL,                -- FR target with article/gender
  accept          TEXT[] NOT NULL DEFAULT '{}', -- alternative accepted answers for typed checking
  kind            TEXT NOT NULL DEFAULT 'vocab',-- vocab | phrase | grammar | question_form | pronunciation | error
  answer_mode     TEXT NOT NULL DEFAULT 'typed',-- typed (bot checks) | self_rated (long phrases) | voice (bot transcribes)
  competency_code TEXT REFERENCES grammar_competencies(code),
  unit_id         INT REFERENCES resource_units(id) ON DELETE SET NULL,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  -- FSRS state
  state           card_state NOT NULL DEFAULT 'new',
  stability       REAL NOT NULL DEFAULT 0,
  difficulty      REAL NOT NULL DEFAULT 0,
  due             TIMESTAMPTZ NOT NULL DEFAULT now(),
  elapsed_days    INT NOT NULL DEFAULT 0,
  scheduled_days  INT NOT NULL DEFAULT 0,
  reps            INT NOT NULL DEFAULT 0,
  lapses          INT NOT NULL DEFAULT 0,
  last_review     TIMESTAMPTZ,
  suspended       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (front, back)
);
CREATE INDEX IF NOT EXISTS ix_04_cards ON cards (due) WHERE NOT suspended;
CREATE INDEX IF NOT EXISTS ix_05_cards ON cards (competency_code);

CREATE TABLE IF NOT EXISTS review_log (
  id              SERIAL PRIMARY KEY,
  card_id         INT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  rating          SMALLINT NOT NULL,            -- 1 again · 2 hard · 3 good · 4 easy (typed answers map: wrong=1, slow/typo=2, right=3, fast=4)
  state_before    card_state NOT NULL,
  elapsed_days    INT NOT NULL,
  scheduled_days  INT NOT NULL,                 -- interval assigned by this review
  stability_after REAL NOT NULL,
  difficulty_after REAL NOT NULL,
  typed_answer    TEXT,
  latency_ms      INT,
  environment     environment,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_06_review_log ON review_log (card_id, reviewed_at);

-- ========================================= EVALUATIONS (CLB engine) ======
-- Every graded production task. clb_sub is the simulated TCF sub-score (1-12) for THAT task.
CREATE TABLE IF NOT EXISTS submissions (
  id              SERIAL PRIMARY KEY,
  skill           skill NOT NULL,               -- writing | speaking
  task_type       TEXT NOT NULL,                -- tcf_w1 | tcf_w2 | tcf_w3 | tcf_s1 | tcf_s2 | tcf_s3 | interview | micro | shadow | free
  environment     environment,
  prompt          TEXT NOT NULL,
  content         TEXT,                         -- text, or transcript for speaking
  audio_file      TEXT,
  word_count      INT,
  duration_s      INT,
  -- grade
  score_20        NUMERIC(4,1),                 -- TCF-style /20
  clb_sub         NUMERIC(4,2),                 -- 1.00-12.00 simulated CLB for this task
  criteria        JSONB,                        -- {task_fulfilment, coherence, vocabulary, grammar, fluency_pronunciation} each 1-12
  corrections     JSONB,                        -- [{original, fix, why, competency_code|null, error_type}]
  feedback        JSONB,                        -- {strengths[], next_focus[], feedback_en, corrected_text}
  graded_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_07_submissions ON submissions (skill, graded_at DESC);

-- Receptive items (listening/reading MCQ, dictation, comprehension). One row per item answered.
CREATE TABLE IF NOT EXISTS quiz_results (
  id              SERIAL PRIMARY KEY,
  skill           skill NOT NULL,               -- listening | reading
  item_clb        NUMERIC(4,2) NOT NULL,        -- difficulty of the item
  correct         BOOLEAN NOT NULL,
  unit_id         INT REFERENCES resource_units(id) ON DELETE SET NULL,
  question        TEXT,
  environment     environment,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_08_quiz_results ON quiz_results (skill, created_at DESC);

-- Exam-readiness evidence, collected from day one so the TCF estimate is never bolted on at the end.
-- One row per scored thing that maps onto a TCF component. `exam_format` = it was a real TCF-shaped
-- item/task (listening/reading set, tcf_w*/tcf_s*, interview, mock), not a lesson exercise: readiness
-- confidence is driven by how much of the evidence is exam-shaped, and mocks outrank everything.
CREATE TABLE IF NOT EXISTS exam_evidence (
  id            SERIAL PRIMARY KEY,
  component     skill NOT NULL,               -- listening | reading | writing | speaking
  source        TEXT NOT NULL,                -- quiz_item | submission | live | mock
  source_id     INT,
  exam_format   BOOLEAN NOT NULL DEFAULT FALSE,
  item_clb      NUMERIC(4,2) NOT NULL,        -- item difficulty (receptive) or graded clb_sub (productive)
  correct       BOOLEAN,                      -- receptive items only; NULL for a graded task
  weight        NUMERIC(3,2) NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_11_exam_evidence ON exam_evidence (component, created_at DESC);

-- Non-grammar recurring problems (pronunciation, lexis, register). Grammar goes to grammar_evidence.
CREATE TABLE IF NOT EXISTS error_patterns (
  id              SERIAL PRIMARY KEY,
  category        TEXT NOT NULL UNIQUE,         -- 'voyelles nasales', 'anglicisme', 'registre familier à l'écrit'
  kind            TEXT NOT NULL,                -- pronunciation | lexis | register | spelling | comprehension
  count           INT NOT NULL DEFAULT 1,
  example         TEXT,
  last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ================================================= PLANNING & DELIVERY ====
CREATE TABLE IF NOT EXISTS plans (
  plan_date       DATE PRIMARY KEY,
  plan            JSONB NOT NULL,               -- {focus, rationale, message, slots:[{environment, time, minutes, items:[...]}]}
  inputs_digest   JSONB,                        -- snapshot the planner saw (for audit/debug)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
  id              SERIAL PRIMARY KEY,
  plan_date       DATE NOT NULL,
  environment     environment NOT NULL,
  slot            TEXT NOT NULL,                -- morning_card | patrol | srs | driving | seated | checkin | surprise_test | weekly
  scheduled_at    TIMESTAMPTZ NOT NULL,
  payload         JSONB NOT NULL,               -- items to render
  status          TEXT NOT NULL DEFAULT 'pending',   -- pending | sending | sent | completed | failed | skipped | stale
  sent_at         TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,                  -- set when the gate check for the slot passes
  error           TEXT
);
CREATE INDEX IF NOT EXISTS ix_09_deliveries ON deliveries (status, scheduled_at);

-- Minutes: only bot-verified sessions are 'verified'; free-text logs are 'reported'.
CREATE TABLE IF NOT EXISTS activity_log (
  id              SERIAL PRIMARY KEY,
  log_date        DATE NOT NULL,
  environment     environment NOT NULL,
  activity        TEXT NOT NULL,
  minutes         INT NOT NULL,
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  ref_table       TEXT, ref_id INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_10_activity_log ON activity_log (log_date);

-- Conversation state machine (what the bot is waiting for) + small caches.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v JSONB NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Synthesised audio segments (drill prompts/answers), keyed by sha1(voice|style|text). Lets drills recycle cards for free.
CREATE TABLE IF NOT EXISTS tts_cache (
  key         TEXT PRIMARY KEY,
  mp3         BYTEA NOT NULL,
  duration_ms INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO learner (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO fsrs_params (id, weights) VALUES (1, ARRAY[0.4072,1.1829,3.1262,15.4722,7.2102,0.5316,1.0651,0.0234,1.616,0.1544,1.0824,1.9813,0.0953,0.2975,2.2042,0.2407,2.9466,0.5034,0.6567]) ON CONFLICT DO NOTHING;

-- ================================================== MODULE LAYER =========
-- The capability matrix (ARCHITECTURE §3.5): one row per (module, skill) the module declares.
-- DERIVED, never written by hand — lib/modules.ts recomputes it from evidence already being
-- collected (quiz_results, unit_checks, grammar_evidence, submissions) plus card stability as the
-- retention dimension. 'Passed lesson 12' cannot tell knowing a rule apart from being able to say
-- it out loud; this table can, and the weakest cell is what the planner should attack next.
CREATE TABLE IF NOT EXISTS module_state (
  module_id       TEXT NOT NULL,
  skill           skill NOT NULL,
  state           TEXT NOT NULL DEFAULT 'unseen',
                  -- unseen | introduced | practicing | competent | retaining | mastered | maintenance
  score           NUMERIC(4,3) NOT NULL DEFAULT 0,     -- 0..1 recency-weighted accuracy, shrunk when thin
  confidence      NUMERIC(3,2) NOT NULL DEFAULT 0,     -- 0..1 from observation count
  evidence_count  INT NOT NULL DEFAULT 0,
  exam_evidence_count INT NOT NULL DEFAULT 0,
  retention       NUMERIC(4,3),                        -- AVG(LEAST(1, card stability / 21 days)), NULL if no cards
  first_competent TIMESTAMPTZ,
  last_evidence   TIMESTAMPTZ,
  next_probe      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_id, skill)
);
CREATE INDEX IF NOT EXISTS ix_15_module_state ON module_state (state, score);

-- ============================================================ VIEWS =======
-- What the planner reads. Keep these cheap; they're joined into the nightly snapshot.
CREATE OR REPLACE VIEW v_grammar_weakest AS
  SELECT c.code, c.name, c.family, c.clb_needed, c.exam_weight, m.mastery_pct, m.confidence, m.status, m.last_evidence,
         (c.exam_weight * (100 - m.mastery_pct) / 100.0) * (CASE WHEN c.clb_needed <= (SELECT target_clb FROM learner) THEN 1 ELSE 0.3 END) AS priority
  FROM grammar_competencies c JOIN grammar_mastery m ON m.competency_code = c.code
  ORDER BY priority DESC;

CREATE OR REPLACE VIEW v_fsrs_load AS
  SELECT COUNT(*) FILTER (WHERE state <> 'new' AND due <= now())                        AS due_now,
         COUNT(*) FILTER (WHERE state <> 'new' AND due <= now() + interval '1 day')     AS due_tomorrow,
         COUNT(*) FILTER (WHERE state = 'new' AND NOT suspended)                        AS new_available,
         COUNT(*) FILTER (WHERE state = 'relearning')                                   AS relearning
  FROM cards WHERE NOT suspended;

CREATE OR REPLACE VIEW v_current_clb AS
  SELECT DISTINCT ON (skill) skill, clb, confidence, computed_at FROM skill_estimates ORDER BY skill, computed_at DESC;

-- How much exam-shaped evidence backs each component (last 90 days). lib/nclc.ts turns this into
-- "AI estimate" vs "test-backed" vs "mock-validated" so an estimate is never mistaken for a result.
CREATE OR REPLACE VIEW v_exam_readiness AS
  SELECT s.skill::text AS component,
         COALESCE(e.items, 0)      AS items,
         COALESCE(e.exam_items, 0) AS exam_items,
         COALESCE(e.mock_items, 0) AS mock_items,
         COALESCE(e.hi_items, 0)   AS hi_items,     -- evidence at CLB 6+ (where NCLC 7 is decided)
         COALESCE(e.hi_correct, 0) AS hi_correct,
         e.last_at
  FROM (SELECT unnest(ARRAY['listening','reading','writing','speaking'])::skill AS skill) s
  LEFT JOIN (
    SELECT component,
           COUNT(*)::int                                                        AS items,
           COUNT(*) FILTER (WHERE exam_format)::int                             AS exam_items,
           COUNT(*) FILTER (WHERE source = 'mock')::int                         AS mock_items,
           COUNT(*) FILTER (WHERE item_clb >= 6)::int                           AS hi_items,
           COUNT(*) FILTER (WHERE item_clb >= 6 AND correct IS NOT FALSE)::int  AS hi_correct,
           MAX(created_at)                                                      AS last_at
    FROM exam_evidence WHERE created_at > now() - interval '90 days' GROUP BY 1
  ) e ON e.component = s.skill;
