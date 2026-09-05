// Nightly planner. Trigger at ~22:30 Toronto (02:30 UTC in summer / 03:30 in winter - vercel.json uses 02:30 UTC).
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildPlan } from "../../lib/planner.js";
import { authorized } from "../../lib/auth.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authorized(req)) return res.status(401).send("unauthorized");
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const { date: d, plan } = await buildPlan(date);
  return res.status(200).json({ date: d, focus: plan.focus, slots: plan.slots.length });
}
