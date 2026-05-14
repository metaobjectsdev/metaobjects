import { z } from "zod";
import { RecordCore } from "./core.js";

export const ConventionRecord = RecordCore.extend({
  type: z.literal("convention"),
  pattern_description: z.string(),
  examples: z.array(z.string()),
  applies_to: z.array(z.string()),
});
export type ConventionRecord = z.infer<typeof ConventionRecord>;
