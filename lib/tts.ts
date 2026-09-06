// Speech synthesis + drill audio assembly.
// Gemini TTS -> PCM 24 kHz -> MP3 (lamejs, pure JS). Segments cached in tts_cache so recycled prompts cost nothing.
// Drill audio = concatenation of MP3 segments + encoded silence for the "pause" gaps (raw MP3 frames concatenate cleanly).
import { createHash } from "node:crypto";
import * as lamejs from "@breezystack/lamejs";
import { ttsPcm } from "./coach.js";
import { sql, one } from "./db.js";

const RATE = 24000, KBPS = 64;
export const VOICE_FR = process.env.GEMINI_TTS_VOICE || "Kore";
export const VOICE_EN = process.env.GEMINI_TTS_VOICE_EN || "Puck";

export function pcmToMp3(pcm: Int16Array): Uint8Array {
  const enc = new lamejs.Mp3Encoder(1, RATE, KBPS);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (out.length) chunks.push(new Uint8Array(out));
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return concat(chunks);
}
export function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const STYLE = {
  fr_slow: "Lis en français, très lentement, en articulant chaque syllabe, avec une courte pause entre les phrases : ",
  fr_normal: "Lis en français à vitesse naturelle, comme un locuteur natif, avec une intonation de conversation : ",
  fr_dialogue: "Lis ce dialogue en français à vitesse naturelle, comme deux personnes qui parlent, avec une pause entre les répliques : ",
  en: "Read in a clear, neutral English voice, like a language-course narrator: ",
} as const;
export type Style = keyof typeof STYLE;

/** One synthesised segment as MP3, cached by (style, voice, text). */
export async function segment(text: string, style: Style): Promise<{ mp3: Uint8Array; ms: number }> {
  const voice = style === "en" ? VOICE_EN : VOICE_FR;
  const key = createHash("sha1").update(`${style}|${voice}|${text}`).digest("hex");
  const hit = await one`SELECT mp3, duration_ms FROM tts_cache WHERE key = ${key}`;
  if (hit) return { mp3: new Uint8Array(hit.mp3), ms: hit.duration_ms };
  const pcm = await withRetry(() => ttsPcm(STYLE[style] + text, voice));
  const mp3 = pcmToMp3(pcm);
  const ms = Math.round((pcm.length / RATE) * 1000);
  await sql`INSERT INTO tts_cache (key, mp3, duration_ms) VALUES (${key}, ${Buffer.from(mp3)}, ${ms}) ON CONFLICT DO NOTHING`;
  return { mp3, ms };
}

let silence1s: Uint8Array | null = null;
function silence(seconds: number): Uint8Array {
  if (!silence1s) silence1s = pcmToMp3(new Int16Array(RATE));
  return concat(Array.from({ length: Math.max(0, Math.round(seconds)) }, () => silence1s!));
}

export async function speakFrench(text: string, speed: "slow" | "normal" = "normal") { return (await segment(text, speed === "slow" ? "fr_slow" : "fr_normal")).mp3; }
export async function speakDialogue(lines: { fr: string }[], speed: "slow" | "normal") {
  const txt = lines.map((l) => l.fr).join("\n");
  return (await segment(txt, speed === "slow" ? "fr_slow" : "fr_dialogue")).mp3;
}

export type DrillStep = { type: "teach" | "prompt" | "answer" | "recap" | "pause"; en?: string; fr?: string; pause_s?: number };

// ---------------------------------------------------------------------------------------------- batching
// The free tier caps TTS *requests* per day, so a 30-segment drill must not be 30 calls. We synthesise up to
// 12 short lines in ONE call ("read these with a clear pause between each"), then split the PCM on the silences.
// If the split doesn't yield exactly the expected number of pieces, we fall back to one call per line.
const keyOf = (text: string, style: Style) => createHash("sha1").update(`${style}|${style === "en" ? VOICE_EN : VOICE_FR}|${text}`).digest("hex");

export function splitOnSilence(pcm: Int16Array, expected: number): Int16Array[] | null {
  const frame = Math.round(RATE * 0.02);                     // 20 ms frames
  const rms: number[] = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) { let e = 0; for (let j = i; j < i + frame; j++) e += pcm[j] * pcm[j]; rms.push(Math.sqrt(e / frame)); }
  const peak = Math.max(...rms, 1);
  const thr = Math.max(peak * 0.04, 120);
  // all silent gaps ≥ 200 ms that sit between speech (ignore leading silence)
  const gaps: { at: number; len: number }[] = [];
  let run = 0, spoken = false;
  for (let f = 0; f < rms.length; f++) {
    if (rms[f] < thr) { run++; }
    else { if (spoken && run >= 10) gaps.push({ at: Math.round((f - run / 2) * frame), len: run }); run = 0; spoken = true; }
  }
  if (gaps.length < expected - 1) return null;
  // the line boundaries are the longest gaps; an intra-sentence comma pause is shorter than the "about one second" we asked for
  const chosen = [...gaps].sort((a, b) => b.len - a.len).slice(0, expected - 1).sort((a, b) => a.at - b.at);
  const shortest = chosen[chosen.length - 1] ? Math.min(...chosen.map((g) => g.len)) : 0;
  const longestRejected = Math.max(0, ...gaps.filter((g) => !chosen.includes(g)).map((g) => g.len));
  if (shortest < 14 || (longestRejected && shortest < longestRejected * 1.3)) return null;   // boundaries not clearly separable
  const out: Int16Array[] = []; let start = 0;
  for (const c of [...chosen.map((g) => g.at), pcm.length]) { out.push(trim(pcm.subarray(start, c), thr)); start = c; }
  return out.every((seg) => seg.length > RATE * 0.25) ? out : null;
}
function trim(seg: Int16Array, thr: number): Int16Array {
  const frame = Math.round(RATE * 0.02);
  let a = 0, b = seg.length;
  const loud = (i: number) => { let e = 0; for (let j = i; j < Math.min(i + frame, seg.length); j++) e += seg[j] * seg[j]; return Math.sqrt(e / frame) >= thr; };
  while (a + frame < b && !loud(a)) a += frame;
  while (b - frame > a && !loud(b - frame)) b -= frame;
  return seg.subarray(Math.max(0, a - frame * 3), Math.min(seg.length, b + frame * 3));
}

/** Synthesise many lines with as few TTS requests as possible; results are cached individually. */
export async function segmentsBatch(lines: string[], style: Style): Promise<Map<string, { mp3: Uint8Array; ms: number }>> {
  const out = new Map<string, { mp3: Uint8Array; ms: number }>();
  const missing: string[] = [];
  for (const t of [...new Set(lines)]) {
    const hit = await one`SELECT mp3, duration_ms FROM tts_cache WHERE key = ${keyOf(t, style)}`;
    if (hit) out.set(t, { mp3: new Uint8Array(hit.mp3), ms: hit.duration_ms }); else missing.push(t);
  }
  const voice = style === "en" ? VOICE_EN : VOICE_FR;
  for (let i = 0; i < missing.length; i += 12) {
    const batch = missing.slice(i, i + 12);
    let pieces: Int16Array[] | null = null;
    if (batch.length > 1) {
      try {
        const intro = style === "en"
          ? "Read the following lines one after another, like a language-course narrator. Leave a clear silent pause of about one second between lines. Do not read any numbers or labels:\n\n"
          : "Lis les phrases suivantes l'une après l'autre, à vitesse naturelle, avec une pause silencieuse nette d'environ une seconde entre chaque phrase. Ne lis aucun numéro :\n\n";
        const pcm = await withRetry(() => ttsPcm(intro + batch.join("\n\n"), voice));
        pieces = splitOnSilence(pcm, batch.length);
      } catch (e) { console.warn("batch tts failed, falling back", String((e as any)?.message ?? e).slice(0, 100)); }
    }
    for (let k = 0; k < batch.length; k++) {
      const t = batch[k];
      const seg = pieces ? { mp3: pcmToMp3(pieces[k]), ms: Math.round((pieces[k].length / RATE) * 1000) } : await segment(t, style);
      if (pieces) await sql`INSERT INTO tts_cache (key, mp3, duration_ms) VALUES (${keyOf(t, style)}, ${Buffer.from(seg.mp3)}, ${seg.ms}) ON CONFLICT DO NOTHING`;
      out.set(t, seg);
    }
  }
  return out;
}

/** Render a drill script into one MP3. prompt -> pause -> answer -> (short gap) -> answer again. */
export async function renderDrill(script: DrillStep[], pauseDefault = 4): Promise<{ mp3: Uint8Array; seconds: number }> {
  const en: string[] = [], fr: string[] = [];
  for (const s of script) {
    if ((s.type === "teach" || s.type === "recap" || s.type === "prompt") && s.en) en.push(s.en);
    if ((s.type === "teach" || s.type === "recap" || s.type === "answer") && s.fr) fr.push(s.fr);
  }
  // teach/recap blocks are long: synthesise them individually; batch the short prompt/answer lines
  const long = new Set([...en, ...fr].filter((t) => t.length > 160));
  const enMap = await segmentsBatch(en.filter((t) => !long.has(t)), "en");
  const frMap = await segmentsBatch(fr.filter((t) => !long.has(t)), "fr_normal");
  for (const t of en.filter((t) => long.has(t))) enMap.set(t, await segment(t, "en"));
  for (const t of fr.filter((t) => long.has(t))) frMap.set(t, await segment(t, "fr_normal"));
  const get = (text: string, style: Style) => (style === "en" ? enMap : frMap).get(text)!;

  const parts: Uint8Array[] = [];
  let ms = 0;
  const push = (seg: { mp3: Uint8Array; ms: number }) => { parts.push(seg.mp3); ms += seg.ms; };
  const gap = (s: number) => { parts.push(silence(s)); ms += s * 1000; };
  for (const s of script) {
    switch (s.type) {
      case "teach": case "recap":
        if (s.en) push(get(s.en, "en"));
        if (s.fr) { gap(0.5); push(get(s.fr, "fr_normal")); }
        gap(1); break;
      case "prompt":
        if (s.en) push(get(s.en, "en"));
        gap(s.pause_s ?? pauseDefault); break;
      case "answer":
        if (s.fr) { push(get(s.fr, "fr_normal")); gap(1.5); push(get(s.fr, "fr_normal")); }
        gap(1); break;
      case "pause": gap(s.pause_s ?? 2); break;
    }
  }
  return { mp3: concat(parts), seconds: Math.round(ms / 1000) };
}

async function withRetry<T>(fn: () => Promise<T>, tries = 2): Promise<T> {
  let err: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      err = e; const msg = String(e?.message ?? e);
      if (!/429|RESOURCE_EXHAUSTED|503|overloaded|quota/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** i));
    }
  }
  throw err;
}
