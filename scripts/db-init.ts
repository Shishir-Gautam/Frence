import "dotenv/config";
import { seedAll } from "../lib/seed.js";
console.log(await seedAll());
process.exit(0);
