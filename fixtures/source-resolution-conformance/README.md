# source-resolution-conformance

Pins how a consumer's `sources` set in `.metaobjects/config.json` resolves to a
set of metadata files. Every port's CLI must resolve the SAME FILES from the
same declaration — that is the cross-port promise this corpus exists to keep.

Companion to `scope-conformance/`, which pins the (currently TypeScript-only)
`scope` pattern grammar. The two are independent: `sources` decides which files
are read, `scope` filters what is emitted from them.

## Shape

```
cases.json   # { cases: [{ name, tree, symlinks?, config, resolveFrom?, expectFiles?, expectError? }] }
README.md
```

- **`tree`** — a map of project-root-relative path → file content. The runner
  materializes it in a fresh temporary directory. A `.keep` entry exists only to
  force an otherwise-empty directory to be created.
- **`symlinks`** — OPTIONAL, a map of project-root-relative `linkPath` →
  project-root-relative `targetPath`. Materialized AFTER `tree` (so the target
  already exists), as a directory symlink at `linkPath` pointing at `targetPath`.
  Exists to gate that every port's directory walk FOLLOWS a symlinked directory
  — whether the `sources` path itself is a symlink
  (`a-symlinked-sources-path-resolves-through-it`) or a symlink sits partway
  through a walked tree (`a-symlinked-subdirectory-inside-a-walked-tree-
  resolves-through-it`) — rather than silently resolving to zero files or
  skipping the subtree. The reported path preserves the symlink's OWN name (a
  file reached through `link/` is reported as `link/…`, never resolved to
  `real/…`) — see "Order is deliberately NOT pinned" below for the parallel
  point about `expectFiles` being exact strings, not just "the same underlying
  file by any name". Every port's runner must honor this key.

  Following symlinks is what makes a symlink CYCLE reachable, so
  `a-symlink-cycle-is-an-error` gates the other half of the same contract: a
  directory symlink that revisits a directory already on the current walk
  branch must RAISE, not be walked. The failure it exists to catch is not a
  hang — it is silent nonsense. Left unguarded, a walk yields the same real
  file at ever-deeper phantom paths (`model/loop/model/loop/…/meta.a.json`),
  and because de-duplication keys on the LEXICAL path those are all distinct,
  so each is admitted as its own source and the same metadata loads over and
  over. Which error is raised is deliberately not pinned (hence `expectError:
  true`) — the ports raise their own native types. What is pinned is that a
  cycle is loud.

  "Already on the current walk BRANCH" is the precise rule, not "already
  seen": the ancestor set must be carried down the recursion and never shared
  between siblings, so a directory legitimately reachable by two different
  symlinked paths — a diamond, not a cycle — still resolves rather than being
  falsely rejected.

  This case is a FLOOR, and deliberately so. On Linux the kernel refuses to
  traverse past its own symlink-resolution depth (ELOOP around 40 levels), so
  an unguarded walk in some runtimes raises anyway — late, and for the wrong
  reason, but it raises, and `expectError: true` cannot tell that apart from a
  real guard. What the case DOES discriminate is a port that swallows that
  kernel error and reports success: C#'s `Directory.EnumerateFiles(...,
  AllDirectories)` defaults to `IgnoreInaccessible`, so before this case it
  completed normally and returned 41 phantom copies of one file. Because the
  floor cannot pin immediacy, each port additionally owns a unit test that the
  raise happens on REVISIT rather than at the kernel's limit — `sources.test.ts`,
  `test_sources.py`, `DirectorySourceTest.java`, `DirectorySourceTests.cs`.
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
- **A TypeScript-owned top-level key does not affect source resolution in any
  port.** `schema_version` and `sources` are the neutral subset every port
  models; `pending_in_git` / `confidence_thresholds` / `extract` / `migrate`
  are TypeScript's own, and `typescript-owned-top-level-keys-do-not-affect-
  source-resolution` pins that their presence resolves the same file set
  everywhere. Read that case name literally — it is narrower than "unknown
  keys are ignored" on purpose. Those four keys are UNKNOWN to Java/C#/Python
  (which ignore any key outside `schema_version`/`sources`, by design) but
  KNOWN to TypeScript's own `ConfigSchema` (`sdk/src/config.ts`), which
  recognizes and validates them as part of its own project state. A case
  built only from keys TS recognizes cannot tell "TS ignored this because it
  doesn't affect resolution" apart from "TS ignored this because it doesn't
  affect resolution AND happened to also validate it" — the two are
  indistinguishable from the outside, and only the first is what every other
  port's "ignore the rest" behavior demonstrates.
  **A genuinely unrecognized key (e.g. `"foo": 1`, unknown to all four ports)
  is a real, confirmed, cross-port DIVERGENCE, not covered by this corpus.**
  Verified empirically: `resolveCollection` (`collection.ts`) calls
  `loadConfig`, which parses the WHOLE file through `ConfigSchema.parse` —
  `.strict()` at the top level (`config.ts`) — so a key no version of
  TypeScript has ever declared throws a `ZodError` and resolution never
  reaches the source-listing step at all, while Java/C#/Python all resolve
  successfully, silently ignoring it. Not added as a shared `expectFiles`
  case here because doing so would need EITHER loosening `ConfigSchema`'s
  top-level strictness (a reference-implementation behavior change with a
  blast radius well beyond source resolution — every `loadConfig` caller,
  not just this corpus) OR asserting a `true`-sentinel `expectError` that
  TypeScript alone would satisfy, contradicting the other three ports'
  actual success — neither of which this corpus is positioned to decide
  unilaterally. Left as an open, human-reviewable follow-up.

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
which error, same as file order above. The same `true` form covers five more
cases beyond this one: an unsupported `schema_version`
(`an-unsupported-schema-version-is-an-error`) and four malformed `sources`
entry shapes (`sources-null-is-an-error-not-the-default`,
`an-empty-path-is-an-error`, `a-sources-entry-with-two-keys-is-an-error`,
`a-non-string-source-value-is-an-error`). Genuinely malformed JSON SYNTAX (an
unparseable `.metaobjects/config.json`) is still not in the corpus — the case
schema's `config` field is always a valid JSON value that the runner
re-serializes via `JSON.stringify`/equivalent, so expressing broken syntax
would need a schema extension carrying raw file text instead of a config
object. Nothing about the `true`-sentinel mechanism is specific to any of
these shapes.

## Behavioral contract

Each port's runner reads `cases.json`, and for every case: materializes `tree`
in a fresh temp directory, then `symlinks` (when present), writes `config`
when non-null under the directory named by `resolveFrom` (default the project
root), resolves sources against that directory, then asserts either that the
resolved file set equals `expectFiles` (as a set, project-root-relative, path
separators normalized to `/`) — AND that its size matches the raw resolved
count, since a Set/HashSet comparison alone cannot see a duplicate emission
collapse invisibly into one set element — or that resolution failed with
`expectError`.

## Reference implementation

`server/typescript/packages/sdk/src/sources.ts` (`resolveSources`) and
`server/typescript/packages/sdk/src/collection.ts` (`resolveCollection`).
