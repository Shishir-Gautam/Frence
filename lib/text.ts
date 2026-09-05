export function splitTelegram(s: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of s.split("\n")) {
    if ((cur + "\n" + line).length > max) { out.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out;
}
