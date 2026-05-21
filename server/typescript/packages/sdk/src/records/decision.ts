import { z } from "zod";
import { RecordCore } from "./core.js";

export const DecisionRecord = RecordCore.extend({
  type: z.literal("decision"),
  rationale: z.string(),
  alternatives_considered: z.array(z.string()),
  scope: z.union([z.literal("global"), z.array(z.string())]),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;
