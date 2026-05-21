import { z } from "zod";
import { RecordCore } from "./core.js";

export const FailureRecord = RecordCore.extend({
  type: z.literal("failure"),
  what_was_tried: z.string(),
  why_it_failed: z.string(),
  do_not_repeat_in: z.array(z.string()).optional(),
  related_decisions: z.array(z.string()).optional(),
});
export type FailureRecord = z.infer<typeof FailureRecord>;
