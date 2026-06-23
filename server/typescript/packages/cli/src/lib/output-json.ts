import type { GenResultShape } from "./output.js";
import { genResultToData } from "./output.js";

export function formatGenResultJson(result: GenResultShape): string {
  return JSON.stringify(genResultToData(result), null, 2);
}
