// Starter deck (~300 cards) so day one isn't empty: survival, self-intro, question forms, connectors, TCF themes.
import "dotenv/config";
import { ask, EXAM } from "../lib/coach.js";
import { addCards } from "../lib/srs.js";
const sets = [
  { name: "survival", prompt: "60 absolute-beginner survival items: greetings, politeness, numbers 0-20, days, asking to repeat/slow down, 'I would like', 'how much', 'where is'." },
  { name: "self", prompt: "40 items to introduce yourself for TCF speaking task 1: name, from Nepal, living in Toronto, security guard, studies, hobbies, family, why French. Tag TNS_PRESENT_IRREG where relevant." },
  { name: "questions", prompt: "40 question-forming chunks for TCF speaking task 2 (est-ce que…, quel/quelle…, combien…, à quelle heure…, où se trouve…, est-il possible de…, pourriez-vous…), full example question each. Tag INT_TROIS_FORMES / INT_MOTS_INTERROGATIFS / INT_INDIRECTE." },
  { name: "connectors", prompt: "40 connectors and opinion structures for CLB 7 task 3 (d'abord, ensuite, cependant, en revanche, à mon avis, je pense que + indicatif, il faut que + subjonctif, bien que…, par exemple, en conclusion), example sentence each. Tag CON_* codes." },
  ...(EXAM.themes as string[]).slice(0, 8).map((t) => ({ name: t, prompt: `25 high-frequency A2/B1 words and chunks for the TCF theme "${t}", nouns with article and gender.` })),
];
let total = 0;
for (const s of sets) {
  const r = await ask<{ cards: any[] }>("EXAMINER", `${s.prompt}\nfront = English prompt (short, disambiguating hint in brackets if needed), back = French, accept = natural variants, kind ∈ vocab|phrase|grammar|question_form, competency_code = grid code or null.\nReturn {"cards":[{"front","back","accept":[],"kind","competency_code"}]}`);
  const n = await addCards((r.cards ?? []).map((c) => ({ ...c, tags: ["seed", s.name] })));
  total += n; console.log(`${s.name}: +${n}`);
}
console.log(`seeded ${total} cards`); process.exit(0);
