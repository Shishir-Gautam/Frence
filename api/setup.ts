// One-time (re-runnable): apply schema, seed toolbox + grammar grid, register webhook + commands.
// GET https://<app>.vercel.app/api/setup?key=CRON_SECRET
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { seedAll } from "../lib/seed.js";
import { setWebhook, setCommands } from "../lib/telegram.js";
import { authorized } from "../lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).send("unauthorized");
  const seeded = await seedAll();
  const host = (req.headers["x-forwarded-host"] ?? req.headers.host) as string;
  const url = `https://${host}/api/telegram`;
  await setWebhook(url, process.env.TELEGRAM_WEBHOOK_SECRET ?? "");
  await setCommands();
  return res.status(200).json({ ok: true, webhook: url, ...seeded });
}
