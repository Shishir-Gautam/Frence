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

/** Render a drill script into one MP3. prompt -> pause -> answer -> (short gap) -> answer again. */
export async function renderDrill(script: DrillStep[], pauseDefault = 4, concurrency = 4): Promise<{ mp3: Uint8Array; seconds: number }> {
  // Synthesise all distinct segments first (bounded concurrency), then assemble in order.
  const jobs: { text: string; style: Style }[] = [];
  for (const s of script) {
    if (s.type === "teach" || s.type === "recap") { if (s.en) jobs.push({ text: s.en, style: "en" }); if (s.fr) jobs.push({ text: s.fr, style: "fr_normal" }); }
    if (s.type === "prompt" && s.en) jobs.push({ text: s.en, style: "en" });
    if (s.type === "answer" && s.fr) jobs.push({ text: s.fr, style: "fr_normal" });
  }
  const uniq = [...new Map(jobs.map((j) => [`${j.style}|${j.text}`, j])).values()];
  const done = new Map<string, { mp3: Uint8Array; ms: number }>();
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < uniq.length) { const j = uniq[i++]; done.set(`${j.style}|${j.text}`, await segment(j.text, j.style)); }
  }));
  const get = (text: string, style: Style) => done.get(`${style}|${text}`)!;

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
