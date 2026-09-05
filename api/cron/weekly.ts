// Sunday evening weekly review. Schedule externally (e.g. Sundays 20:00 Toronto).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getLearner } from "../../lib/db.js";
import { sendWeeklyReport } from "../../lib/progress.js";
import { authorized } from "../../lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).send("unauthorized");
  const l = await getLearner();
  if (!l.chat_id) return res.status(400).send("no chat yet");
  await sendWeeklyReport(l.chat_id);
  return res.status(200).send("ok");
}
