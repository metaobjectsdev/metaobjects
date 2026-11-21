# Writer conformance

The shared cases for the code writer every port's generators write through
([ADR-0063](../../spec/decisions/ADR-0063-generators-own-layout.md)). The contract and the case
format are in [`spec/code-writer.md`](../../spec/code-writer.md).

- `cases/*.json` with `"dialect": "core"` pin the language-neutral core: indentation, blocks,
  blank-line requests, snippets, fit-or-break lists, line endings and the error codes. Every
  port's writer runs them with the options the case states.
- Cases with a language dialect (`"dialect": "typescript"`, `"csharp"`) pin that language's
  writer: import or `using` collection and ordering, doc comments and its defaults. A port runs
  the `core` cases and its own dialect's, and skips the others by name.

Runners: TypeScript, `server/typescript/packages/codegen-ts/test/writer-conformance.test.ts`;
Rust, `server/rust/metaobjects-codegen/tests/writer_conformance.rs` (`core`); C#,
`server/csharp/MetaObjects.Codegen.Tests/WriterConformanceTests.cs` (`core` and `csharp`).
The other ports run the `core` cases when their writers land, and add cases for their own
dialect beside these.

The `csharp` ops are `header` (lines), `using`, `usingStatic` (a namespace or type), `usingAlias`
(alias, target) and `docSummary` (lines), beside the core ops. A `csharp` case may state
`"options": {"usingOrder": "sorted"}`; the default order is the order the generator named them.
