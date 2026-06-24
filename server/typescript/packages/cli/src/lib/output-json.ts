import type { GenResultShape, MigrateResultShape } from "./output.js";
import { genResultToData, migrateResultToData } from "./output.js";

export function formatGenResultJson(result: GenResultShape): string {
  return JSON.stringify(genResultToData(result), null, 2);
}

export function formatMigrateResultJson(result: MigrateResultShape): string {
  return JSON.stringify(migrateResultToData(result), null, 2);
}
