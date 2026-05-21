import { z } from "zod";
import { RecordCore } from "./core.js";

export const PrincipleRecord = RecordCore.extend({
  type: z.literal("principle"),
  statement: z.string(),
  rationale: z.string(),
  scope: z.array(z.string()),
  examples: z.array(z.string()),
  counter_examples: z.array(z.string()),
  enforcement: z.enum(["advisory", "block"]).default("advisory"),
});
export type PrincipleRecord = z.infer<typeof PrincipleRecord>;
