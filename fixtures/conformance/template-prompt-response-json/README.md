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
