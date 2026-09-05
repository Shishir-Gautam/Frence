import "dotenv/config";
import { seedToolbox, seedGrid } from "../lib/seed.js";
console.log({ resources: await seedToolbox(), competencies: await seedGrid() });
process.exit(0);
