// Embeds db/schema.sql and the coach system prompt as TS modules (Vercel bundles only imported code).
import { readFileSync, writeFileSync } from "node:fs";
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
writeFileSync("lib/schema.ts", `// Generated from db/schema.sql (npm run gen). Do not edit.\nexport const SCHEMA = \`${esc(readFileSync("db/schema.sql", "utf8"))}\`;\n`);
writeFileSync("lib/coach-prompt.ts", `// Generated from content/prompts/polyglot-coach.system.md (npm run gen). Do not edit.\nexport const SYSTEM_PROMPT = \`${esc(readFileSync("content/prompts/polyglot-coach.system.md", "utf8"))}\`;\n`);
console.log("generated lib/schema.ts, lib/coach-prompt.ts");
