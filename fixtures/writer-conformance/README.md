# Writer conformance

The shared cases for the code writer every port's generators write through
([ADR-0063](../../spec/decisions/ADR-0063-generators-own-layout.md)). The contract and the case
format are in [`spec/code-writer.md`](../../spec/code-writer.md).

- `cases/*.json` with `"dialect": "core"` pin the language-neutral core: indentation, blocks,
  blank-line requests, snippets, fit-or-break lists, line endings and the error codes. Every
  port's writer runs them with the options the case states.
- Cases with a language dialect (`"dialect": "typescript"`) pin that language's writer: import
  collection and ordering, doc comments and its defaults.

Runner: TypeScript, `server/typescript/packages/codegen-ts/test/writer-conformance.test.ts`.
The other ports run the `core` cases when their writers land, and add cases for their own
dialect beside these.
