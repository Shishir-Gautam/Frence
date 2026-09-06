/** Split for Telegram's 4096-char limit, preferring blank-line boundaries so inline HTML tags aren't cut mid-paragraph. */
export function splitTelegram(s: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  const push = (piece: string) => {
    if ((cur + "\n\n" + piece).length > max && cur) { out.push(cur); cur = piece; } else cur = cur ? cur + "\n\n" + piece : piece;
  };
  for (const para of s.split("\n\n")) {
    if (para.length <= max) { push(para); continue; }
    // a single huge paragraph: fall back to line splits
    let buf = "";
    for (const line of para.split("\n")) {
      if ((buf + "\n" + line).length > max && buf) { push(buf); buf = line; } else buf = buf ? buf + "\n" + line : line;
    }
    if (buf) push(buf);
  }
  if (cur) out.push(cur);
  return out;
}
