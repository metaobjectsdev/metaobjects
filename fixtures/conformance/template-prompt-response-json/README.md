# template-output-json-simple

Documents the FR-010 output codegen contract for a `template.output` with `@format: json`
and `@promptStyle: inline`.

The fixture declares a `SupportAnswer` value-object with a string field, an enum field
(with `@enumAlias` and `@enumDoc`), and an optional note field, wired to a
`SupportAnswerOutput` template.

## Conformance notes

- **Java** asserts structurally: the generators emit `SupportAnswerOutputPrompt.java`
  (containing `OutputFormatRenderer.render(`, `PromptStyle.INLINE`, `Format.JSON`,
  and both `renderFormat()` overloads) and `SupportAnswerOutputParser.java`
  (containing `extractLenient(`, `ExtractSchema EXTRACT_SCHEMA`, `parse(`, and the
  `medium`→`OK` enumAlias entry).
- Behavioral correctness is proven by the codegen-spring compile-run tests
  (`GeneratedOutputPromptCompileRunTest`, `GeneratedExtractLenientCompileRunTest`).
- Byte-identical golden output is the TypeScript / cross-port concern (see
  `expected/` directories in sibling TS fixtures).

## The strict tier and `@enumAlias` (A5)

`confidence` is declared with `@values: [HIGH, OK, LOW]` and `@enumAlias: { medium: OK }`.
The **strict** parser validates the declared MEMBERS only — `expected/` pins
`z.enum(["HIGH", "OK", "LOW"])`, and `"medium"` is rejected there. Alias folding is a
tolerance of the **extract** tier (FR-011), which is where the Java structural assertion
looks for the `medium`→`OK` entry, and where TypeScript's
`extractLenient<Name>WithLoader` folds it. Java's strict `parse` agrees by construction:
it deserializes into a generated Java enum, which has no `medium` constant.

This golden previously pinned `confidence: z.unknown()` — the TS strict schema dropped the
enum domain entirely, so every reply passed. That was the defect, not the contract; the
fixture could not fail because `z.unknown()` accepts whatever the test feeds it.
