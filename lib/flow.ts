// Flow arbitration: one interactive thing at a time, and slots delivered one item at a time.
//
//   kv "slot_queue"        remaining items of the slot being delivered  {chatId, env, deliveryId, items, current}
//   kv "check_session"     a running check (checks.ts)
//   kv "srs_session"       a running card session (srs.ts)
//   kv "interview_session" a running interview (grade.ts)
//   kv "awaiting"          what a free-text / voice reply means when no session is running: writing | speaking | checkin
//   kv "srs_deferred"      a card session that was postponed because a check/interview was running
//   kv "spot_pending"      drill id whose spot check hasn't been taken yet (run at the next micro slot)
//
// Every item type has exactly one completion hook that calls itemDone(): check finish, grade finish, srs end.
import { sql, kvGet, kvSet, kvDel } from "./db.js";
import { sendMessage, esc } from "./telegram.js";

export type Queue = { chatId: number; env: string; deliveryId?: number; items: any[]; current?: any; started: number };

export async function busy(): Promise<"check" | "srs" | "interview" | null> {
  if (await kvGet("check_session")) return "check";
  if (await kvGet("interview_session")) return "interview";
  if (await kvGet("srs_session")) return "srs";
  return null;
}

/** Start delivering a slot: store the queue and send the first item. */
export async function startQueue(q: Omit<Queue, "started" | "current">, sendItem: (item: any) => Promise<any>) {
  const queue: Queue = { ...q, started: Date.now() };
  await kvSet("slot_queue", queue, 8 * 60);
  return advance(sendItem);
}

/** Send the next queued item; when the queue is empty mark the delivery completed. */
export async function advance(sendItem: (item: any) => Promise<any>) {
  const q = await kvGet<Queue>("slot_queue");
  if (!q) return false;
  const next = q.items.shift();
  if (!next) {
    await kvDel("slot_queue");
    if (q.deliveryId) await sql`UPDATE deliveries SET status = 'completed', completed_at = now() WHERE id = ${q.deliveryId}`;
    await sendMessage(q.chatId, "✅ Slot done.");
    return false;
  }
  q.current = next;
  await kvSet("slot_queue", q, 8 * 60);
  try { await sendItem(next); }
  catch (e: any) {
    console.error(e);
    await sendMessage(q.chatId, `⚠️ Couldn't build the next item: ${esc(String(e?.message ?? e)).slice(0, 200)}`, [[{ text: "⏭ Next item", callback_data: "q:next" }]]);
  }
  return true;
}

/** Called by every completion hook. Resumes a deferred card session first, then the slot queue. */
export async function itemDone(sendItem: (item: any) => Promise<any>, startSrs: (chatId: number, count: number) => Promise<any>) {
  const deferred = await kvGet<{ chatId: number; count: number }>("srs_deferred");
  if (deferred && !(await busy())) { await kvDel("srs_deferred"); await startSrs(deferred.chatId, deferred.count); return; }
  await advance(sendItem);
}

export async function queueInfo() { return kvGet<Queue>("slot_queue"); }
export async function clearAll() { for (const k of ["slot_queue", "check_session", "srs_session", "interview_session", "awaiting", "srs_deferred"]) await kvDel(k); }
