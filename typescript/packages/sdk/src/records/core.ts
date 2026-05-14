import { z } from "zod";

export const RecordType = z.enum([
  "convention",
  "decision",
  "principle",
  "glossary",
  "failure",
]);
export type RecordType = z.infer<typeof RecordType>;

export const RecordSource = z.enum([
  "ts-ast",
  "drizzle",
  "prisma",
  "openapi",
  "human",
  "claude",
  "llm-from-commits",
  "llm-from-prs",
  "ingest:ts-ast",
  "ingest:drizzle",
  "ingest:zod",
]);
export type RecordSource = z.infer<typeof RecordSource>;

export const RecordCore = z.object({
  schema_version: z.literal(1),
  type: RecordType,
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string(),
  confidence: z.number().min(0).max(1),
  source: RecordSource,
  captured_at: z.string().datetime(),
  last_validated_against_commit: z.string(),
  superseded_by: z.string().optional(),
  evidence: z
    .object({
      commits: z.array(z.string()).optional(),
      prs: z.array(z.string()).optional(),
      conversation_id: z.string().optional(),
    })
    .optional(),
  deviations: z
    .array(
      z.object({
        when: z.string().datetime(),
        why: z.string(),
        conversation_id: z.string().optional(),
      }),
    )
    .default([]),
});

export type RecordCore = z.infer<typeof RecordCore>;
