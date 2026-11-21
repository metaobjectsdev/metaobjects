# codegen-skip-conformance

The shared table of cases for [ADR-0064](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md):
which changes must make `gen` regenerate, which may let it skip, and what a local
`verify --codegen` may do after each.

`cases.json` is the whole corpus. It holds no project: each port builds a small project of its
own shape (its own config file, generator wiring and template roots), runs `gen` once, applies
each case's change, and asks its skip decision. A runner fails on a case id it does not know, so
adding a case here reaches every port at once.

| Port | Runner |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/gen-skip-conformance.test.ts` |
| Python | `server/python/tests/test_gen_skip_conformance.py` |
| C# | `server/csharp/MetaObjects.Cli.Tests/GenSkipConformanceTests.cs` |
| Java | `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/GenSkipConformanceTest.java` |
| Kotlin | the Java runner, with a Kotlin generator configured (Kotlin generators run through `metaobjects:generate`) |
| Rust | `server/rust/metaobjects-codegen/tests/skip_conformance.rs` (the cases its `gen` can meet; the rest are named with their reason) |

The values:

- `gen`: `skip` (the next `gen` may load the metadata to compute its key, but must render nothing and write nothing) or `regenerate` (it must run
  in full).
- `verify`: `may-answer-no-drift` (a local `verify --codegen` may answer from the stored key and
  the manifest without rendering) or `must-render` (it must render and compare).

## `manifests.json`: the hash manifest is one file per package

[ADR-0064 Amendment 1](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md) replaces the
single `.metaobjects/.gen-state/.hashes.json` with one file per model package under `.hashes/`. The
vectors in `manifests.json` are run by each port's manifest unit tests, beside the cases above:

- `fileNames`: a package's manifest file name (`null` is the root manifest, `.root.json`).
- `placement`: for the loaded `objects`, which manifest a recorded path (and its entry) is filed
  under: the `sourceNode` rule first, then the stem rule, else the root.
- `legacySplit`: a legacy `.hashes.json` is split into exactly `files` (parsed content; `goldenText`
  is one file's bytes in full), the legacy file is removed, and a second identical write changes no
  file. `gitignoreBefore` becomes `gitignoreAfter`; a file that already holds the new line, or has no
  `.gen-state/*` rule, is left alone.

A port's tests also assert what the vectors cannot: two writes that change entries in two packages
change two files and no third, a save that changes nothing writes nothing, a package that loses its
last entry loses its file, and a read-only command migrates nothing.
