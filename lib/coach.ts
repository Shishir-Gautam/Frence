// The Polyglot Coach: one system prompt, four roles. Every Gemini call goes through here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import exam from "../content/exam/tcf-canada.json" with { type: "json" };
import competencies from "../content/grammar/competencies.json" with { type: "json" };
import { SYSTEM_PROMPT } from "./coach-prompt.js";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// Model chain: primary from env, then fallbacks. A 503 "high demand" / 429 on one model moves to the next.
const list = (v: string | undefined, dflt: string[]) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : dflt);
// gemini-2.5-flash is closed to new users (404) — never put it in the text chain.
export const TEXT_MODELS = [...new Set(list(process.env.GEMINI_MODEL, ["gemini-3.8-flash"]).concat(list(process.env.GEMINI_FALLBACK_MODELS, ["gemini-3.7-flash", "gemini-3.6-flash"])))].filter((m) => !/^gemini-2\./.test(m));
export const TTS_MODELS = list(process.env.GEMINI_TTS_MODEL, ["gemini-3.1-flash-tts-preview"]).concat(list(process.env.GEMINI_TTS_FALLBACK_MODELS, ["gemini-2.5-flash-preview-tts"]));

const transient = (e: any) => /\b(503|429|404|UNAVAILABLE|RESOURCE_EXHAUSTED|NOT_FOUND|overloaded|high demand)\b/i.test(String(e?.message ?? e));
/** Daily free-tier quota gone (as opposed to a per-minute spike): no point retrying other models for a while. */
export const isQuotaExhausted = (e: any) => /exceeded your current quota|RESOURCE_EXHAUSTED.*quota|check your plan and billing/i.test(String(e?.message ?? e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pause everything until the free-tier daily reset (midnight Pacific) once the quota is gone. */
export async function quotaPause() {
  const { kvSet } = await import("./db.js");
  const now = new Date();
  const pacificMidnight = new Date(now); pacificMidnight.setUTCHours(7, 5, 0, 0);   // 00:05 PT (UTC-7); off by an hour in winter, harmless
  if (pacificMidnight <= now) pacificMidnight.setUTCDate(pacificMidnight.getUTCDate() + 1);
  await kvSet("quota_paused_until", { until: pacificMidnight.toISOString() }, Math.ceil((pacificMidnight.getTime() - now.getTime()) / 60000));
  return pacificMidnight;
}
export async function quotaPaused(): Promise<Date | null> {
  const { kvGet } = await import("./db.js");
  const p = await kvGet<{ until: string }>("quota_paused_until");
  return p ? new Date(p.until) : null;
}

/** Try each model in order; on a transient error retry once after a short backoff, then move on. */
export async function withModels<T>(models: string[], fn: (model: string) => Promise<T>): Promise<T> {
  let last: any;
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fn(m); }
      catch (e: any) {
        last = e;
        if (isQuotaExhausted(e)) { await quotaPause(); throw e; }
        if (!transient(e)) throw e;
        console.warn(`gemini ${m} transient (${attempt + 1}/2): ${String(e?.message ?? e).slice(0, 120)}`);
        if (attempt === 0) await sleep(1500);
      }
    }
  }
  throw last;
}

export const EXAM = exam;
export const COMPETENCIES = competencies as { code: string; family: string; name: string; clb_needed: number; exam_weight: number; prerequisites: string[]; description: string; test_focus?: string[] }[];
export const CODES = new Set(COMPETENCIES.map((c) => c.code));

export type Role = "PLANNER" | "DRILL AUTHOR" | "EXAMINER" | "GRADER" | "TUTOR";

function system(role: Role) {
  return `${SYSTEM_PROMPT}\n\n=== ACTIVE ROLE: ${role} ===\n\nEXAM MODEL:\n${JSON.stringify(EXAM)}\n\nGRAMMAR GRID CODES (the only valid competency_code values):\n${COMPETENCIES.map((c) => `${c.code} — ${c.name} [CLB ${c.clb_needed}, w${c.exam_weight}]`).join("\n")}`;
}

/** JSON call in a given role. `parts` may include inline audio. */
export async function ask<T = any>(role: Role, user: string, opts: { audio?: { data: Uint8Array; mime: string }; temperature?: number } = {}): Promise<T> {
  const parts: any[] = [];
  if (opts.audio) parts.push({ inlineData: { mimeType: opts.audio.mime, data: Buffer.from(opts.audio.data).toString("base64") } });
  parts.push({ text: user });
  const r = await withModels(TEXT_MODELS, (model) => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts }],
    config: { systemInstruction: system(role), temperature: opts.temperature ?? 0.4, responseMimeType: "application/json" },
  }));
  const txt = (r.text ?? "").trim();
  return extractJson<T>(txt, role);
}

/** Parse the first complete JSON object/array in a model reply, ignoring fences, prose, or a second stray object after it. */
export function extractJson<T = any>(txt: string, role = "model"): T {
  try { return JSON.parse(txt) as T; } catch { /* fall through */ }
  const cleaned = txt.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const start = cleaned.search(/[{\[]/);
  if (start >= 0) {
    const open = cleaned[start], close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, escp = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) { if (escp) escp = false; else if (ch === "\\") escp = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(cleaned.slice(start, i + 1)) as T; } catch { break; } } }
    }
  }
  throw new Error(`Gemini (${role}) returned non-JSON: ${txt.slice(0, 200)}`);
}

/** Free-text answer (TUTOR role, learner questions). */
export async function tutor(user: string): Promise<string> {
  const r = await withModels(TEXT_MODELS, (model) => ai.models.generateContent({
    model, contents: user,
    config: { systemInstruction: SYSTEM_PROMPT + "\n\n=== ACTIVE ROLE: TUTOR === Answer the learner's question in ≤120 words of plain text (no markdown). English explanation, French examples.", temperature: 0.5 },
  }));
  return r.text ?? "";
}

/** Text-to-speech: raw 16-bit PCM mono 24 kHz. */
export async function ttsPcm(text: string, voice: string): Promise<Int16Array> {
  const r = await withModels(TTS_MODELS, (model) => ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text }] }],
    config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  }));
  const part = r.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!part?.inlineData?.data) throw new Error("TTS returned no audio");
  const buf = Buffer.from(part.inlineData.data, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

/** Diagnostic: which text/TTS models answer right now. */
export async function pingModels(): Promise<string[]> {
  const out: string[] = [];
  for (const m of TEXT_MODELS) {
    const t0 = Date.now();
    try { await ai.models.generateContent({ model: m, contents: "Réponds: ok", config: { maxOutputTokens: 5 } }); out.push(`✅ ${m} (${Date.now() - t0} ms)`); }
    catch (e: any) { out.push(`❌ ${m}: ${String(e?.message ?? e).slice(0, 90)}`); }
  }
  for (const m of TTS_MODELS) {
    const t0 = Date.now();
    try { await ai.models.generateContent({ model: m, contents: [{ role: "user", parts: [{ text: "Dis en français : bonjour, ça va ?" }] }], config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } }); out.push(`✅ ${m} TTS (${Date.now() - t0} ms)`); }
    catch (e: any) { out.push(`❌ ${m} TTS: ${String(e?.message ?? e).slice(0, 90)}`); }
  }
  return out;
}

export const competencyName = (code: string) => COMPETENCIES.find((c) => c.code === code)?.name ?? code;
export const validCode = (code: string | null | undefined) => (code && CODES.has(code) ? code : null);
export const clbToCefr = (clb: number) => clb < 3 ? "A1" : clb < 5 ? "A2" : clb < 7 ? "B1" : clb < 9 ? "B2" : "C1";
export const themes = () => EXAM.themes as string[];
export const randomTheme = () => themes()[Math.floor(Math.random() * themes().length)];
