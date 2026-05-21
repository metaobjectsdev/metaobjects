import { z } from "zod";
import { ConventionRecord } from "./convention.js";
import { DecisionRecord } from "./decision.js";
import { PrincipleRecord } from "./principle.js";
import { GlossaryRecord } from "./glossary.js";
import { FailureRecord } from "./failure.js";

export const AnyRecord = z.discriminatedUnion("type", [
  ConventionRecord,
  DecisionRecord,
  PrincipleRecord,
  GlossaryRecord,
  FailureRecord,
]);
export type AnyRecord = z.infer<typeof AnyRecord>;
