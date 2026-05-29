# template-output-xml-simple

Documents the FR-010 output codegen contract for a `template.output` with `@format: xml`
and `@promptStyle: guide`.

The fixture declares the same `SupportAnswer` value-object as `template-output-json-simple`
(string field, enum field with `@enumAlias` and `@enumDoc`, optional note), wired to a
`SupportAnswerOutput` template with XML format and guide prompt style.

## Conformance notes

- **Java** asserts structurally: the generators emit `SupportAnswerOutputPrompt.java`
  (containing `OutputFormatRenderer.render(`, `PromptStyle.GUIDE`, `Format.XML`,
  and both `renderFormat()` overloads) and `SupportAnswerOutputParser.java`
  (containing `recover(`, `RecoverSchema RECOVER_SCHEMA`, `parse(`, and the
  `medium`→`OK` enumAlias entry).
- Behavioral correctness is proven by the codegen-spring compile-run tests
  (`GeneratedOutputPromptCompileRunTest`, `GeneratedRecoverCompileRunTest`).
- Byte-identical golden output is the TypeScript / cross-port concern (see
  `expected/` directories in sibling TS fixtures).
