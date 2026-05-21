import { z } from "zod";
import { RecordCore } from "./core.js";

export const GlossaryRecord = RecordCore.extend({
  type: z.literal("glossary"),
  term: z.string(),
  synonyms: z.array(z.string()),
  definition: z.string(),
  code_anchors: z.object({
    entity: z.string().optional(),
    files: z.array(z.string()).optional(),
  }),
  see_also: z.array(z.string()),
});
export type GlossaryRecord = z.infer<typeof GlossaryRecord>;
