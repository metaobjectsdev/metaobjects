# FR6-ts — TypeScript `template.output` parser codegen + `meta verify` extension

**Status:** Design — implementation-ready
**Date:** 2026-05-25
**Scope:** TypeScript — `@metaobjectsdev/codegen-ts` (parser emission) + `@metaobjectsdev/cli` (`meta verify` extension)
**Depends on:** [ADR-0010](../../../spec/decisions/ADR-0010-template-output-parser-codegen.md); existing `payload-codegen.ts` (shipped 0.6.0); existing `verify.ts` (shipped 0.6.0)
**Parent:** [FR6 cross-port design](./2026-05-25-fr6-template-output-parser-codegen.md)

## Goal

For every declared `template.output` in the metadata, codegen emits a TypeScript
parser file with the dual-API shape from ADR-0010:

```ts
// Generated NpcResponse.output.ts
import { z } from "zod";
import { NpcResponse } from "./NpcResponse";   // existing payload-VO

const NpcResponseSchema = z.object({
  name: z.string(),
  age: z.number().int(),
  // ... derived from @payloadRef's payload-VO shape
});

export type NpcResponseValidationError = z.ZodError;

/**
 * Parse an LLM response into a typed NpcResponse.
 * @throws ZodError on validation failure.
 */
export function parseNpcResponse(text: string): NpcResponse {
  const parsed = JSON.parse(text);
  return NpcResponseSchema.parse(parsed);
}

/**
 * Parse an LLM response with explicit error handling (Result-style).
 * Does not throw on validation failure.
 */
export function safeParseNpcResponse(
  text: string,
): { success: true; data: NpcResponse } | { success: false; error: NpcResponseValidationError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // JSON parse failure: surface as ZodError-shaped result for uniformity.
    return { success: false, error: zErr("invalid JSON: " + (err as Error).message) };
  }
  const result = NpcResponseSchema.safeParse(parsed);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}
```

(`zErr(msg)` is a small helper that constructs a synthetic `ZodError` for the
JSON-parse-failure case — keeps the failure shape uniform between "JSON parse
failed" and "schema validation failed.")

Plus `meta verify` extends to check output drift.

## Design

### 1. New codegen factory: `outputParserFile()`

A new generator factory in `@metaobjectsdev/codegen-ts/generators` alongside
`entityFile()`, `queriesFile()`, `barrel()`, `promptRender()`:

```ts
// metaobjects.config.ts (consumer)
import { defineConfig } from "@metaobjectsdev/cli";
import {
  entityFile, queriesFile, barrel,
  promptRender,       // existing — emits typed render handles
  outputParser,       // NEW — emits typed parsers for template.output
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  generators: [
    entityFile(), queriesFile(), barrel(),
    promptRender(),
    outputParser(),
  ],
});
```

`outputParser()` is per-entity (or per-template-node) — emits one file per
`template.output` declaration, named `<Name>.output.ts`.

### 2. Reuse the payload-codegen substrate

`generatePayloadInterfaces()` (existing in `payload-codegen.ts`) already produces
TypeScript types from `object.value` payload declarations. The new parser codegen:

- Reads the `template.output`'s `@payloadRef`.
- Resolves the payload-VO from metadata.
- Walks the payload-VO's fields to derive a Zod schema (`z.object(...)`).
- Emits the schema + dual-API parsers.

Field-type → Zod-type mapping is the same as existing TS codegen:

| Field subtype | Zod type |
|---|---|
| `field.string` | `z.string()` (with `.min`/`.max` from `@maxLength` etc.) |
| `field.int` / `field.long` / `field.short` / `field.byte` | `z.number().int()` |
| `field.double` / `field.float` | `z.number()` |
| `field.boolean` | `z.boolean()` |
| `field.date` / `field.time` / `field.timestamp` | `z.string().datetime()` or `z.coerce.date()` |
| `field.enum` | `z.enum([...values])` |
| `field.currency` | `z.number().int()` (minor units, per ADR currency contract) |
| `field.object` (with `@objectRef`) | nested object schema for the referenced VO |
| `isArray: true` | wrap in `z.array(...)` |

### 3. `meta verify` extension

`server/typescript/packages/cli/src/commands/verify.ts` extends:

```ts
// Current logic (paraphrased)
for (const templateNode of templates) {
  if (templateNode.subtype === "prompt") {
    checkPromptDrift(templateNode);   // existing
  } else if (templateNode.subtype === "output") {
    checkOutputDrift(templateNode);   // NEW
  }
}
```

`checkOutputDrift` walks the parser-schema (derivable from the `@payloadRef`'s
payload-VO) and verifies every field in the schema matches a field in the
payload-VO. The check is **derived**, not loaded — we don't read the generated
parser file; we re-derive what the parser WOULD assert and compare to the source.

Diagnostic output gains a `kind: "prompt" | "output"` field on each finding so CI
dashboards / log scrapers can distinguish.

### 4. Conformance fixture: `template-output-simple`

A new shared corpus fixture exercising `template.output` codegen:

```
fixtures/conformance/template-output-simple/
├── input/
│   └── meta.npc.json           # declares NpcResponse object.value +
│                               # template.output[NpcResponseOutput] with @payloadRef
├── expected.json               # parsed-metadata round-trip
└── expected/
    └── NpcResponseOutput.output.ts   # the generated parser, byte-exact
```

TS conformance runner verifies `outputParser()` applied to the fixture's input
produces `expected/NpcResponseOutput.output.ts` byte-for-byte.

C# / Python / Java runners ignore the `expected/NpcResponseOutput.output.ts` (it's
TS-specific). When those ports ship their FR6, they add their own `expected/*`
artifact alongside (`.cs`, `.py`, `.java`).

## Tests + verification

### Unit tests

- `codegen-ts/test/output-parser-codegen.test.ts` — unit tests on the
  field-type → Zod-type mapping (covers each subtype above).
- `codegen-ts/test/generators/output-parser.test.ts` — factory tests: empty
  metadata → no files; metadata with one `template.output` → one file;
  metadata with both `template.prompt` and `template.output` for same payload →
  correct emit for both, no duplication.

### Golden tests

- `codegen-ts/test/golden/__snapshots__/{sqlite,postgres}/*.output.ts` — golden
  snapshots of the emitted parsers across representative payload-VO shapes
  (strings, numbers, enums, nested objects, arrays).

### Conformance

- The new `template-output-simple` fixture with `expected/NpcResponseOutput.output.ts`.

### `meta verify` tests

- `cli/test/unit/verify-output.test.ts` — tests with drifted metadata:
  - Payload-VO has field X, output schema (derived) doesn't include X → finding with `kind: "output"`.
  - Payload-VO renames field; output schema still references old name → finding.
  - No drift → no findings.

## File-level change summary

**New files:**

- `server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts` — the `outputParser()` factory.
- `server/typescript/packages/codegen-ts/src/templates/output-parser.ts` — the per-file emit template (mirrors existing `templates/queries.ts`, `templates/entity-file.ts` patterns).
- `server/typescript/packages/codegen-ts/test/generators/output-parser.test.ts`
- `server/typescript/packages/codegen-ts/test/output-parser-codegen.test.ts`
- `fixtures/conformance/template-output-simple/input/meta.npc.json`
- `fixtures/conformance/template-output-simple/expected.json`
- `fixtures/conformance/template-output-simple/expected/NpcResponseOutput.output.ts`
- `server/typescript/packages/cli/test/unit/verify-output.test.ts`

**Modified files:**

- `server/typescript/packages/codegen-ts/src/generators/index.ts` — re-exports `outputParser`.
- `server/typescript/packages/codegen-ts/src/index.ts` — package-level re-export.
- `server/typescript/packages/cli/src/commands/verify.ts` — per-subtype branch + `kind` field on diagnostics.
- `server/typescript/packages/cli/src/commands/verify.ts` corresponding test file updates.
- `server/typescript/packages/metadata/test/conformance/adapter.ts` — conformance runner extension to verify `expected/*.output.ts` byte-match when present.

## Out of scope

- Provider-side schema artifacts (OpenAI `response_format`, etc.) — future FR if demand.
- Workflow handle codegen (render → call → parse combined) — out of scope per ADR-0010.
- Streaming-output parsing — out of scope; the parser takes a complete string.
- Per-attribute parse-error attribution — Zod's `safeParse` already returns per-path issues in its error; we expose them as-is via the dual API. Future enhancement could surface them more ergonomically.

## Open questions

None — every implementation decision is settled. Next step: writing-plans.
