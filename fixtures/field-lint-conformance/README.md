# `verify` field-lint conformance corpus

Every port's `verify` command prints an advisory **field authoring lint**. It reports two
metadata mistakes that load with no error:

| Code | What it reports |
|---|---|
| `WARN_REFERENCE_FIELD_NOT_FOUND` | An `identity.reference` whose `@fields` names a field its object does not have. |
| `WARN_DUPLICATE_FIELD_NAME` | A field name declared more than once in one object's `children` list. |

Both are warnings and never a load error: the compatibility policy
(`docs/compatibility-policy.md`) does not allow a new load error for metadata that loads
today. Neither reaches an exit code.

This corpus is the shared source of truth for the codes, the node addresses and the message
text. Each port's own test suite runs it, so the ports cannot drift.

## Fixture format

Each case is a directory:

- `input/` holds one or more metadata documents (`.json` or `.yaml`).
- `expected.json` holds `{ "findings": [{ "code", "path", "message" }] }`.

A runner does three things, in this order:

1. Load `input/` with the port's loader, strict, and assert **no load errors**. This is
   what proves each condition loads today.
2. Run the reference half over the loaded model and the duplicate half over the raw files
   in `input/`.
3. Compare the findings with `expected.json` as an unordered set of
   `(code, path, message)`.

`path` is the declaring object's resolution key (`<package>::<name>`), a dot, then the
identity name or the field name. A `::`-relative package is expanded against the declaring
file's root package in every port (`reference-field-missing-multi-root-package`).

## The two halves read different things

**The reference half reads the loaded model.** Whether an object has a field is a question
about its *effective* field set, so the lint counts:

- a field **inherited** through `extends` (`reference-field-inherited-clean`);
- a field added by an **overlay** file (`reference-field-from-overlay-clean`).

A reference is reported once, on the object that declares it, and is checked against that
object's effective fields. An inherited reference is not repeated on every subtype
(`reference-declared-on-base-reported-once`).

**The duplicate half reads the raw documents.** The TypeScript, C# and Java loaders fold a
repeated field into the first declaration and drop one of a different subtype, so their
loaded model keeps no trace of the duplicate. The Python loader keeps both nodes. One scan
of the document gives every port the same answer. The scan covers root-level objects, and
accepts the YAML authoring sugar (a bare `field` key, a scalar body, a `[]` key suffix).

The scope is **one `children` list**. These are not findings:

- a subtype redeclaring an inherited field. That is an override
  (`duplicate-inherited-override-clean`).
- an overlay file redeclaring a field of its base. That is the overlay merge
  (`duplicate-across-overlay-clean`).

## Who asserts it

| Port | Runner |
|---|---|
| TypeScript (reference) | `server/typescript/packages/cli/test/field-lint-conformance.test.ts` |
| C# | `server/csharp/MetaObjects.Cli.Tests/FieldLintConformanceTests.cs` |
| Java / Kotlin | `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/FieldLintConformanceTest.java` |
| Python | `server/python/tests/conformance/test_field_lint_conformance.py` |

Kotlin has no CLI of its own. Its codegen runs through the Maven `metaobjects:verify` goal,
so the Java runner covers it.
