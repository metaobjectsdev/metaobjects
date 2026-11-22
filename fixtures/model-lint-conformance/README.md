# `verify` model-lint conformance corpus

`meta verify` prints three advisory **model authoring lints** about metadata that loads
with no error:

| Code | What it reports |
|---|---|
| `WARN_OVERLAY_IMPLICIT` | A root-level declaration redeclared in a second file without `overlay: true`. |
| `WARN_NAME_SURROUNDING_WHITESPACE` | A node name with leading or trailing whitespace. |
| `WARN_NAME_INTERNAL_WHITESPACE` | A node name with whitespace inside it. |
| `WARN_DEPRECATED_REFERENCE` | A node that depends on a `deprecated` node through `extends`, `@objectRef`, `@references`, or an origin's `@from` / `@of` / `@via`. |

All are warnings and never a load error, and none reaches an exit code. The rules each one
applies are in [`docs/features/cli.md`](../../docs/features/cli.md). This corpus is the
shared source of truth for the codes, the addresses and the message text.

Runners today: TypeScript (the reference, `server/typescript/packages/cli/test/model-lint-conformance.test.ts`)
and C# (`server/csharp/MetaObjects.Cli.Tests/ModelLintConformanceTests.cs`).

## Fixture format

Each case is a directory:

- `input/` holds one or more metadata documents (`.json` or `.yaml`).
- `expected.json` holds `{ "findings": [{ "code", "path", "message" }] }`.

A runner does three things, in this order:

1. Load `input/` with the port's loader, strict, and assert **no load errors**. This is
   what proves each condition loads today.
2. Run the overlay lint over the files of `input/` **sorted by name** (that order is the
   load order: the first unflagged declaration of a key is its base), naming each file
   relative to `input/`. Run the name lint and the deprecation lint over the loaded model.
3. Compare the findings with `expected.json` as an unordered set of
   `(code, path, message)`.

## Paths

- An overlay finding is about a file, not a node: its `path` is `""`, and the message
  names the file.
- A name finding's `path` is the node's address: the root-level node's
  `<package>::<name>`, then `.`-joined child names. A segment holding whitespace is
  JSON-quoted, so the whitespace stays visible (`acme::app::Account."code "`).
- A deprecation finding's `path` is the referring node's address: `<package>::<name>`, then
  `.`-joined child names. An origin reports against the field that carries it.

## Whitespace

"Whitespace" is exactly the ECMAScript `\s` class, the same set `String.prototype.trim`
strips: ASCII space, tab, LF, CR, VT and FF, plus U+00A0, U+1680, U+2000–U+200A, U+2028,
U+2029, U+202F, U+205F, U+3000 and U+FEFF. A port whose regex `\s` differs (Python's
includes U+001C–U+001F and U+0085, and omits U+FEFF) spells the class out.
