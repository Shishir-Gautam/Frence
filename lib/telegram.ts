const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

export const CHAT_ID = () => Number(process.env.TELEGRAM_CHAT_ID);

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type Keyboard = InlineButton[][];

async function call<T = any>(method: string, body: any): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

async function callMultipart<T = any>(method: string, fields: Record<string, any>, file: { field: string; name: string; data: Uint8Array; type: string }): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  form.append(file.field, new Blob([file.data as unknown as ArrayBuffer], { type: file.type }), file.name);
  const res = await fetch(`${API}/${method}`, { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
  return data.result;
}

/** HTML-escape user/AI text for parse_mode=HTML */
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sendMessage(chatId: number, html: string, keyboard?: Keyboard, extra: any = {}) {
  return call("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    ...extra,
  });
}

export function editMessage(chatId: number, messageId: number, html: string, keyboard?: Keyboard) {
  return call("editMessageText", {
    chat_id: chatId, message_id: messageId, text: html, parse_mode: "HTML",
    reply_markup: keyboard ? { inline_keyboard: keyboard } : { inline_keyboard: [] },
  }).catch(() => {});
}

export function answerCallback(id: string, text?: string) {
  return call("answerCallbackQuery", { callback_query_id: id, text }).catch(() => {});
}

/** Voice note. Telegram accepts OGG/OPUS, MP3 or M4A for sendVoice. Returns file_id for caching. */
export async function sendVoice(chatId: number, mp3: Uint8Array, caption?: string, keyboard?: Keyboard, filename = "audio.mp3"): Promise<string> {
  const r = await callMultipart("sendVoice", {
    chat_id: chatId, caption, parse_mode: "HTML",
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  }, { field: "voice", name: filename, data: mp3, type: "audio/mpeg" });
  return r.voice?.file_id;
}

/** Re-send a previously uploaded voice by file_id (no re-upload, no TTS cost). */
export function sendVoiceById(chatId: number, fileId: string, caption?: string, keyboard?: Keyboard) {
  return call("sendVoice", {
    chat_id: chatId, voice: fileId, caption, parse_mode: "HTML",
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

/** Native Telegram quiz poll - great for MCQ listening/reading items. */
export function sendQuiz(chatId: number, question: string, options: string[], correctIndex: number, explanation?: string) {
  return call("sendPoll", {
    chat_id: chatId, question, options, type: "quiz",
    correct_option_id: correctIndex, is_anonymous: false, explanation,
  });
}

export function sendChatAction(chatId: number, action: "typing" | "record_voice" | "upload_voice") {
  return call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
}

export async function downloadFile(fileId: string): Promise<Uint8Array> {
  const f = await call("getFile", { file_id: fileId });
  const res = await fetch(`${FILE_API}/${f.file_path}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function setWebhook(url: string, secret: string) {
  return call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query", "poll_answer"] });
}

export function setCommands() {
  return call("setMyCommands", {
    commands: [
      { command: "today", description: "Show today's plan" },
      { command: "review", description: "Do SRS reviews now" },
      { command: "lesson", description: "Send the current Assimil lesson" },
      { command: "write", description: "Give me a writing task" },
      { command: "speak", description: "Give me a speaking prompt" },
      { command: "listen", description: "TCF-style listening set" },
      { command: "read", description: "TCF-style reading set" },
      { command: "progress", description: "Progress vs CLB 7" },
      { command: "nclc", description: "TCF Canada readiness (estimate + evidence)" },
      { command: "fr", description: "Say a thought in French: /fr I'm off at eight" },
      { command: "roadmap", description: "The 40-unit map and where you are" },
      { command: "log", description: "Log minutes: /log 25 patrol" },
      { command: "replan", description: "Regenerate today's plan" },
      { command: "next", description: "Next item of the current slot" },
      { command: "more", description: "Keep going — give me the next thing" },
      { command: "skip", description: "Abandon the current item/test" },
      { command: "ping", description: "Check which Gemini models respond" },
      { command: "help", description: "What can I do" },
    ],
  });
}
