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
export const TEXT_MODELS = list(process.env.GEMINI_MODEL, ["gemini-3.8-flash"]).concat(list(process.env.GEMINI_FALLBACK_MODELS, ["gemini-3.7-flash", "gemini-3.5-flash"]));
export const TTS_MODELS = list(process.env.GEMINI_TTS_MODEL, ["gemini-3.1-flash-tts-preview"]).concat(list(process.env.GEMINI_TTS_FALLBACK_MODELS, ["gemini-2.5-flash-preview-tts"]));

const transient = (e: any) => /\b(503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand)\b/i.test(String(e?.message ?? e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Try each model in order; on a transient error retry once after a short backoff, then move on. */
export async function withModels<T>(models: string[], fn: (model: string) => Promise<T>): Promise<T> {
  let last: any;
  for (const m of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await fn(m); }
      catch (e: any) {
        last = e;
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
  try { return JSON.parse(txt) as T; } catch {
    const m = txt.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error(`Gemini (${role}) returned non-JSON: ${txt.slice(0, 200)}`);
  }
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
    try { await ai.models.generateContent({ model: m, contents: [{ role: "user", parts: [{ text: "Bonjour" }] }], config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } } }); out.push(`✅ ${m} TTS (${Date.now() - t0} ms)`); }
    catch (e: any) { out.push(`❌ ${m} TTS: ${String(e?.message ?? e).slice(0, 90)}`); }
  }
  return out;
}

export const competencyName = (code: string) => COMPETENCIES.find((c) => c.code === code)?.name ?? code;
export const validCode = (code: string | null | undefined) => (code && CODES.has(code) ? code : null);
export const clbToCefr = (clb: number) => clb < 3 ? "A1" : clb < 5 ? "A2" : clb < 7 ? "B1" : clb < 9 ? "B2" : "C1";
export const themes = () => EXAM.themes as string[];
export const randomTheme = () => themes()[Math.floor(Math.random() * themes().length)];
