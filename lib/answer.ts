// Typed-answer checking: accent/case/punctuation tolerant, with an "almost" tier for near misses.
export function normalize(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}
/** Strips optional leading articles/pronoun hints in brackets: "la clé (f)" -> "la cle". */
const strip = (s: string) => normalize(s.replace(/\(.*?\)/g, ""));

export function levenshtein(a: string, b: string) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export type Verdict = "exact" | "close" | "wrong";
/** exact = matches expected or any accepted alternative (accent-insensitive); close = ≤1 edit per 6 chars. */
export function check(given: string, expected: string, accept: string[] = []): Verdict {
  const g = strip(given);
  const targets = [expected, ...accept].map(strip).filter(Boolean);
  if (targets.includes(g)) return "exact";
  // article-optional: "cle" vs "la cle"
  const noArt = (s: string) => s.replace(/^(le|la|les|l'|un|une|des|du|de la|de l'|de) /, "");
  if (targets.some((t) => noArt(t) === noArt(g))) return "close";
  const best = Math.min(...targets.map((t) => levenshtein(g, t) / Math.max(6, t.length)));
  return best <= 1 / 6 ? "close" : "wrong";
}

/** Map a verdict (+ answer latency) to an FSRS rating. */
export function verdictToRating(v: Verdict, latencyMs?: number): 1 | 2 | 3 | 4 {
  if (v === "wrong") return 1;
  if (v === "close") return 2;
  return latencyMs !== undefined && latencyMs < 6000 ? 4 : 3;
}
