# source-resolution-conformance

Pins how a consumer's `sources` set in `.metaobjects/config.json` resolves to a
set of metadata files. Every port's CLI must resolve the SAME FILES from the
same declaration — that is the cross-port promise this corpus exists to keep.

Companion to `scope-conformance/`, which pins the (currently TypeScript-only)
`scope` pattern grammar. The two are independent: `sources` decides which files
are read, `scope` filters what is emitted from them.

## Shape

```
cases.json   # { cases: [{ name, tree, config, resolveFrom?, expectFiles?, expectError? }] }
README.md
```

- **`tree`** — a map of project-root-relative path → file content. The runner
  materializes it in a fresh temporary directory. A `.keep` entry exists only to
  force an otherwise-empty directory to be created.
- **`config`** — written verbatim to `.metaobjects/config.json`, under the
  directory named by `resolveFrom` (project root when `resolveFrom` is absent).
  When `null`, no config file is created at all.
- **`resolveFrom`** — OPTIONAL, a project-root-relative directory path,
  default `"."`. Names the directory the resolver is invoked against — i.e.
  the directory treated as holding `.metaobjects/`. Exists so a case can prove
  a relative `path` source resolves against the *declaring config's*
  directory rather than the project root or the process's ambient working
  directory: put `resolveFrom` somewhere other than `"."` and a `path` source
  containing `../` only lands on the right files if the port under test
  resolved it against the right base. Every port's runner must honor this key
  — it is part of the case schema from the start rather than retrofitted once
  three ports already exist.
- **`expectFiles`** — project-root-relative paths (NOT relative to
  `resolveFrom`), compared as an **UNORDERED SET**. See "Order is
  deliberately not pinned" below.
- **`expectError`** — either a STRING error code the resolution must fail with
  exactly, or the literal `true` meaning "must raise, but which error/code is
  deliberately not pinned across ports" (see "Also deliberately NOT pinned:
  the malformed-config error code" below for why the latter form exists).
  Exactly one of `expectFiles` / `expectError` is present per case.

## Semantics pinned here

- **Default.** `sources` absent or empty ⇒ exactly one `path` source, the literal
  `metaobjects`. It is a default VALUE, never a requirement.
- **Replacement, not merge.** A declared `sources` replaces the default entirely —
  the default directory is not implicitly appended.
- **Relative base.** A relative `path` resolves against the directory HOLDING the
  `.metaobjects/` folder, never against the process working directory. See
  `a-parent-relative-path-resolves-against-the-declaring-configs-directory`,
  which uses `resolveFrom` to invoke resolution from a subdirectory while the
  config's own `path` source climbs back out with `../` — the case only
  passes when a port resolves relative to the config's directory, not to
  wherever the process happened to be started.
- **Recursion.** A directory `path` is walked recursively; a file `path` resolves
  to that one file.
- **Extensions.** `.json`, `.yaml`, `.yml`, matched case-insensitively. Nothing else.
  See `metadata-extensions-are-matched-case-insensitively`, which mixes
  `.JSON`/`.YAML`/`.Yml` spellings alongside a normal lowercase file AND a
  same-family unsupported extension in uppercase (`.TXT`) — a port that only
  lowercases `.json` (missing `.yaml`/`.yml`), or that folds case and then
  matches too loosely (accepting any extension once folded), diverges from
  this case either way.
- **Union with de-duplication.** Overlapping sources yield each file exactly once.
- **A declared path that does not exist is `ERR_SOURCE_UNRESOLVED`** — never a
  silent skip. Only the DEFAULT may be absent, and then it is
  `ERR_COLLECTION_NOT_FOUND`.
- **`resource` and `package` kinds are declared but resolve nowhere yet:**
  `ERR_SOURCE_KIND_UNSUPPORTED`.
- **Kind validation precedes path resolution, and that precedence is
  order-independent.** Every spec's kind is checked across the WHOLE
  declared list before any spec's path is touched on disk — so a multi-spec
  list containing both an unsupported kind and a path that does not exist
  always fails `ERR_SOURCE_KIND_UNSUPPORTED`, in EITHER declaration order,
  never `ERR_SOURCE_UNRESOLVED`. See
  `unsupported-kind-precedes-unresolved-path-when-path-is-declared-first`
  and its `-declared-second` sibling — a port that interleaves the two
  checks one spec at a time (kind-check-then-stat, per spec, in a single
  loop) reports whichever error comes first in declaration order instead,
  diverging on exactly one of the two cases depending on which order it
  happens to process first.
- **Unknown top-level config keys are IGNORED.** The file carries
  TypeScript-owned keys no other port models. `schema_version` and `sources` are
  the neutral subset; each port validates those strictly and ignores the rest.

## Order is deliberately NOT pinned

`expectFiles` is a set. The ports' directory walks already differ and always
have — Java sorts by basename (`DirectorySource.java:105`), C# by full-path
ordinal (`DirectorySource.cs:64`), Python by basename
(`directory_source.py:40-48`), TypeScript walks depth-first with files before
subdirectories (`metadata-files.ts:101-121`). Making order a contract would be a
behavior change in three ports for no benefit: super-resolution is
order-independent (#188) and the loader's overlay partition discards caller
order anyway.

A port MAY have a stable internal order — several do, and their own generated
output depends on it. It just is not a cross-port promise.

## Also deliberately NOT pinned: the malformed-config error code

`sources-must-be-an-array-not-an-object` pins that a `.metaobjects/config.json`
that exists but is malformed (here: `sources` declared as a bare object instead
of an array) MUST raise rather than silently degrade to "no config" — the
regression this case exists to catch is a wrong-typed `sources` reading as
absent, falling back to the default `metaobjects/` directory with no
diagnostic at all, even when a stale file sits there. It uses `"expectError":
true` rather than a string code, because which code it raises with is left to
each port. The reference implementation is why: `collection.ts:129-140` has no
try/catch around config loading and lets the raw zod/JSON error propagate, so
TypeScript throws a `ZodError` carrying no MetaObjects error code at all.
Pinning a shared code across ports would mean changing the reference, which
this corpus does not do. Python raises `ERR_COLLECTION_NOT_FOUND`; C# and Java
both raise `ERR_BAD_ATTR_VALUE` — three distinct outcomes across four ports,
which is exactly why this case checks only that resolution raises, never with
which error, same as file order above. The same `true` form is available to
any future malformed-config case that needs it (bad JSON, an unsupported
`schema_version`, a malformed `sources` entry shape, …) — none of those are
in the corpus yet, but nothing about the mechanism is specific to this one
shape.

## Behavioral contract

Each port's runner reads `cases.json`, and for every case: materializes `tree`
in a fresh temp directory, writes `config` when non-null under the directory
named by `resolveFrom` (default the project root), resolves sources against
that directory, then asserts either that the resolved file set equals
`expectFiles` (as a set, project-root-relative, path separators normalized to
`/`) or that resolution failed with `expectError`.

## Reference implementation

`server/typescript/packages/sdk/src/sources.ts` (`resolveSources`) and
`server/typescript/packages/sdk/src/collection.ts` (`resolveCollection`).
