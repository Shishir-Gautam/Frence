// Delivery pump: call every 10 min from cron-job.org / QStash. Sends what is due; idempotent.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../../lib/db.js";
import { runDelivery } from "../../lib/deliver.js";
import { authorized } from "../../lib/auth.js";
import { quotaPaused } from "../../lib/coach.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).send("unauthorized");
  const paused = await quotaPaused();
  if (paused && paused > new Date()) return res.status(200).json({ paused_until: paused.toISOString() });   // quota gone: hold deliveries, don't spam errors
  await sql`UPDATE deliveries SET status='stale' WHERE status='pending' AND scheduled_at <= now() - interval '6 hours'`;
  // a delivery stuck in 'sending' for 15 min was killed mid-flight: give it one more go, then fail it
  await sql`UPDATE deliveries SET status = CASE WHEN error LIKE 'retried%' THEN 'failed' ELSE 'pending' END, error = 'retried: timeout' WHERE status='sending' AND sent_at IS NULL AND scheduled_at <= now() - interval '15 minutes' AND (error IS NULL OR error NOT LIKE 'retried%')`;
  // one retry for transient failures (503 / 429)
  await sql`UPDATE deliveries SET status='pending', error = 'retried: ' || error WHERE status='failed' AND error IS NOT NULL AND error NOT LIKE 'retried%' AND (error ~* '503|429|UNAVAILABLE|high demand|overloaded') AND scheduled_at > now() - interval '3 hours'`;
  const due = await sql`SELECT id, slot, environment, payload, plan_date::text AS plan_date FROM deliveries
    WHERE status = 'pending' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 2`;
  const out: any[] = [];
  for (const d of due) {
    const claimed = await sql`UPDATE deliveries SET status='sending' WHERE id=${d.id} AND status='pending' RETURNING id`;
    if (!claimed.length) continue;
    try { await runDelivery(d as any); await sql`UPDATE deliveries SET status='sent', sent_at=now() WHERE id=${d.id} AND status='sending'`; out.push({ id: d.id, slot: d.slot, ok: true }); }
    catch (e: any) { console.error(e); await sql`UPDATE deliveries SET status='failed', error=${String(e.message ?? e).slice(0, 500)} WHERE id=${d.id}`; out.push({ id: d.id, slot: d.slot, ok: false, error: String(e.message ?? e) }); }
  }
  return res.status(200).json({ sent: out });
}
