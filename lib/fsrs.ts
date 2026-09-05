// FSRS-4.5 scheduler. Weights come from fsrs_params (seeded with defaults; can be optimised from review_log later).
// Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
export type Rating = 1 | 2 | 3 | 4;   // again, hard, good, easy
export type State = "new" | "learning" | "review" | "relearning";
export type Params = { w: number[]; requestRetention: number; maximumInterval: number };

export const DEFAULT_W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
const DECAY = -0.5, FACTOR = 19 / 81;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

export type CardState = { state: State; stability: number; difficulty: number; reps: number; lapses: number; last_review: Date | null };
export type Scheduled = CardState & { due: Date; scheduled_days: number; elapsed_days: number };

export function retrievability(stability: number, elapsedDays: number) {
  return stability <= 0 ? 0 : Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
}

export function schedule(card: CardState, rating: Rating, p: Params, now = new Date()): Scheduled {
  const w = p.w;
  const nextInterval = (s: number) => clamp(Math.round((s / FACTOR) * (Math.pow(p.requestRetention, 1 / DECAY) - 1)), 1, p.maximumInterval);
  const initS = (r: Rating) => Math.max(0.1, w[r - 1]);
  const initD = (r: Rating) => clamp(w[4] - Math.exp(w[5] * (r - 1)) + 1, 1, 10);
  const nextD = (d: number, r: Rating) => clamp(w[7] * initD(4) + (1 - w[7]) * (d - w[6] * (r - 3)), 1, 10);
  const recallS = (d: number, s: number, R: number, r: Rating) =>
    s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - R)) - 1) * (r === 2 ? w[15] : 1) * (r === 4 ? w[16] : 1));
  const forgetS = (d: number, s: number, R: number) => Math.min(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - R)), s);

  let { state, stability: s, difficulty: d, reps, lapses } = card;
  const elapsed = card.last_review ? Math.max(0, (now.getTime() - card.last_review.getTime()) / 86400000) : 0;
  const elapsed_days = Math.round(elapsed);

  if (state === "new" || reps === 0) { s = initS(rating); d = initD(rating); }
  else { const R = retrievability(s, elapsed); d = nextD(d, rating); s = rating === 1 ? forgetS(d, s, R) : recallS(d, s, R, rating); }
  reps += 1;

  let due: Date, scheduled_days = 0;
  const min = (m: number) => new Date(now.getTime() + m * 60000);
  const days = (n: number) => new Date(now.getTime() + n * 86400000);
  if (rating === 1) {
    if (state === "review") lapses += 1;
    state = state === "review" || state === "relearning" ? "relearning" : "learning";
    due = min(10);
  } else if (state === "new" || state === "learning" || state === "relearning") {
    if (rating === 2) { state = "learning"; due = min(30); }
    else { scheduled_days = rating === 4 ? Math.max(2, nextInterval(s)) : 1; state = "review"; due = days(scheduled_days); }
  } else {
    scheduled_days = nextInterval(s);
    if (rating === 2) scheduled_days = Math.max(1, Math.round(scheduled_days * 0.8));
    state = "review"; due = days(scheduled_days);
  }
  return { state, stability: s, difficulty: d, reps, lapses, last_review: now, due, scheduled_days, elapsed_days };
}
