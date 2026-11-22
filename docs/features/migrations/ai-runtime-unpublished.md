# Migration — the trace helper's call loop is generated; `@metaobjectsdev/ai-runtime` is unpublished (`1.3.0`)

**TypeScript only; regenerate, then drop a dependency.** The generated `call<Entity>` trace
helpers imported `runLlmCall` and the `LlmClient` seam from `@metaobjectsdev/ai-runtime`. From
1.3.0 the `trace-helper` generator writes that call loop into your project as `llm-call.ts`,
beside the `<Entity>.trace.ts` modules, and the package is no longer published. Its last
version, 1.2.3, stays on npm, so nothing breaks until you choose to move.

## What to change

| Before | After |
|---|---|
| `@metaobjectsdev/ai-runtime` in `dependencies` | remove it, after regenerating |
| `import type { LlmClient } from "@metaobjectsdev/ai-runtime"` | `import type { LlmClient } from "<outDir>/llm-call"` |
| `import { runLlmCall } from "@metaobjectsdev/ai-runtime"` | the same name from the generated `llm-call.ts` |

Run `meta gen`. Each `<Entity>.trace.ts` whose prompt carries `@textRef` changes one import, to
`./llm-call`, and `llm-call.ts` appears beside it. The `LlmClient` you wrote does not change:
the interface is the same.

**An owned `trace-helper`** (`meta eject trace-helper`, 1.1 or later) keeps writing what your
copy writes, including the old import, so it keeps working against 1.2.3. To move, take a fresh
copy with `meta eject trace-helper --force` and re-apply your edits, or add the second file to
your copy: it is `renderLlmCallSupport()` written to `LLM_CALL_SUPPORT_FILE`, both exported
from `@metaobjectsdev/codegen-ts`.

**`callLlm`, `CompositeRecorder` and the Langfuse and OpenTelemetry recorders** are not
generated. They stay in the repository under `server/typescript/packages/ai-runtime/` as
reference source; copy the ones you use into your project.

## Also fixed

A `<Entity>.trace.ts` whose response value object has a required field did not compile under
`strict`: it cast the extracted record straight to the value object's interface, which
TypeScript refuses when the types do not overlap. It now casts through `unknown`, after the
helper has checked that no required field was lost or malformed.

## Why

Generated code should import nothing from MetaObjects beyond ordinary published packages, and
the call loop is code an adopter owns anyway: the client it calls is theirs. See
[ADR-0024](../../../spec/decisions/ADR-0024-ai-trace-scope-and-llm-caller-boundary.md),
Amendment 2.
