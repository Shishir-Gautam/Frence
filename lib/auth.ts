import type { VercelRequest } from "@vercel/node";

/** Accepts Vercel Cron (Authorization: Bearer CRON_SECRET) or ?key=CRON_SECRET / x-cron-key header for external schedulers. */
export function authorized(req: VercelRequest) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization;
  return h === `Bearer ${s}` || req.headers["x-cron-key"] === s || req.query.key === s;
}
