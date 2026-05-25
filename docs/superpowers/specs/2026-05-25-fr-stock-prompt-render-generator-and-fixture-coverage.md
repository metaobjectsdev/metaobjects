# FR: Stock `promptRender()` generator + `template-prompt-simple` `expected/` codegen output

**Status:** Design — implementation-ready
**Date:** 2026-05-25
**Scope:** TypeScript (`@metaobjectsdev/codegen-ts`) + cross-language conformance fixture
**Origin:** Friction observed in a downstream consumer's mid-0.6.0 adoption — every adopter
who wants typed `renderXxx()` handles writes the same custom `Generator` wrapping the
already-exported `generateRenderHandle()` + `generatePayloadInterfaces()`. Same adopters
also report the codegen contract is invisible to the conformance corpus.

## Goal

1. Add a stock `promptRender()` generator factory to `@metaobjectsdev/codegen-ts/generators`
   that bundles `generateRenderHandle()` + `generatePayloadInterfaces()` into a single
   one-shot-per-run emitter, mirroring the shape of `entityFile()`, `queriesFile()`, etc.
2. Add `expected/prompts.ts` to `fixtures/conformance/template-prompt-simple/` so the
   codegen contract for `template.prompt` is documented as data, not just code.

## Why

`@metaobjectsdev/codegen-ts/payload-codegen` exports both helpers
(`generatePayloadInterfaces` at `payload-codegen.ts:79`, `generateRenderHandle` at `:90`),
and they work — but no factory in `codegen-ts/src/generators/` wires them into a default
`Generator`. Every consumer who wants typed prompt handles writes ~20 lines of identical
boilerplate in their `metaobjects.config.ts`:

```ts
const promptCodegen: Generator = {
  name: "prompt-render",
  emit(ctx) {
    const payloads = ctx.entities.filter(e => e.kind === "object.value");
    const prompts  = ctx.entities.filter(e => e.kind === "template.prompt");
    return [{
      path: "src/render/generated/prompts.ts",
      content: [
        generatePayloadInterfaces(payloads),
        ...prompts.map(generateRenderHandle),
      ].join("\n"),
    }];
  },
};
```

The fixture gap is the second half of the same problem: `fixtures/conformance/template-prompt-simple/`
ships `input/meta.ai.json` + `expected.json` (the parsed-metadata tree), but no
`expected/` directory showing what the codegen emits. A recon agent grepping the corpus
for "what does `template.prompt` codegen look like" finds nothing — even though the
generator exists.

## Design

### Part 1 — `promptRender()` generator factory

New file `server/typescript/packages/codegen-ts/src/generators/prompt-render-file.ts`:

```ts
import { code } from "ts-poet";
import { MetaObject } from "@metaobjectsdev/metadata";
import { generatePayloadInterfaces, generateRenderHandle } from "../payload-codegen.js";
import type { Generator } from "../generator.js";

export interface PromptRenderOpts {
  /** Relative path within the entity-module target. Default: "prompts.ts". */
  outFile?: string;
}

export function promptRender(opts: PromptRenderOpts = {}): Generator {
  const outFile = opts.outFile ?? "prompts.ts";
  return {
    name: "prompt-render",
    type: "once-per-run",
    emit(ctx) {
      const payloads = ctx.entities.filter((e): e is MetaObject => e.kind === "object.value");
      const prompts  = ctx.entities.filter((e): e is MetaObject => e.kind === "template.prompt");
      if (payloads.length === 0 && prompts.length === 0) return [];
      const body = [
        generatePayloadInterfaces(payloads),
        ...prompts.map(generateRenderHandle),
      ].filter((s) => s.length > 0).join("\n\n");
      return [{ path: outFile, content: body }];
    },
  };
}
```

Re-export from `src/generators/index.ts`:

```ts
export { promptRender, type PromptRenderOpts } from "./prompt-render-file.js";
```

Consumer usage becomes:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, barrel, promptRender } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  generators: [entityFile(), queriesFile(), barrel(), promptRender()],
});
```

### Part 2 — `expected/` codegen output in the conformance fixture

Generate the codegen output once against `template-prompt-simple/input/meta.ai.json` and
commit it at `fixtures/conformance/template-prompt-simple/expected/prompts.ts`. Extend
the TS conformance runner to also assert that `promptRender()` applied to the input
metadata produces the file at `expected/prompts.ts` byte-for-byte.

Cross-language note: the **fixture** is cross-language (shared corpus). The C# and Java
ports already exercise `template-prompt-simple` for round-trip; they should also exercise
the new `expected/prompts.ts` assertion *if and when* they ship payload-VO codegen against
the same fixture (C# already does per CLAUDE.md; Java does not yet). Adding the file does
not break any existing runner — runners that don't check `expected/` simply ignore it.

## Tests

- `codegen-ts/test/generators/prompt-render-file.test.ts` — unit test on the factory
  function: empty metadata → no emitted files; mixed metadata → single file with
  payload interfaces + handles in expected order.
- TS conformance runner: byte-identical check between `promptRender()` output and
  `fixtures/conformance/template-prompt-simple/expected/prompts.ts`.

## Out of scope

- `template.output` codegen path. See separate FR
  `2026-05-25-fr-template-output-codegen-pipeline-design.md` for the design of structured-output
  codegen. The stock generator here covers `template.prompt` only — same surface as
  `generateRenderHandle()` today.
- Wiring `promptRender()` into `meta init` scaffold's default `metaobjects.config.ts`.
  That's a separate, smaller call — easy to add once this lands.

## Open questions

None — this is the smallest possible factory wrapping existing exports, and the fixture
addition is mechanical.
