# Writer conformance

The shared cases for the code writer every port's generators write through
([ADR-0063](../../spec/decisions/ADR-0063-generators-own-layout.md)). The contract and the case
format are in [`spec/code-writer.md`](../../spec/code-writer.md).

- `cases/*.json` with `"dialect": "core"` pin the language-neutral core: indentation, blocks,
  blank-line requests, snippets, fit-or-break lists, line endings and the error codes. Every
  port's writer runs them with the options the case states.
- Cases with a language dialect (`"dialect": "typescript"`, `"dialect": "java"`) pin that
  language's writer: import collection and ordering, doc comments and its defaults. A runner
  skips the dialects that are not its own.

Runners:

- TypeScript, `server/typescript/packages/codegen-ts/test/writer-conformance.test.ts` (`core` and `typescript`).
- Java, `server/java/codegen-base/src/test/java/com/metaobjects/generator/writer/WriterConformanceTest.java` (`core` and `java`).
- Rust, `server/rust/metaobjects-codegen/tests/writer_conformance.rs` (`core`).

The ports without a writer yet (C#, Kotlin, Python) run the `core` cases when their writers
land, and add cases for their own dialect beside these.
