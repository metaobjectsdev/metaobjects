# Cross-port metadata `sources` — design

_Status: DESIGN (decisions made; implementation plan is a separate document)._
_Date: 2026-08-19._
_Follows: `2026-08-17-metadata-source-resolution-design.md` (phase 1, TypeScript, merged as PR #311)._
_Evidence: `2026-08-17-metadata-source-resolution-prior-art.md`._

## 1. What this decides

Phase 1 gave the Node `meta` CLI three keys in the port-neutral `.metaobjects/config.json`:
`sources`, `scope`, and `migrate.scope`. The other four CLIs read none of them.

This document decides how the **Java, Kotlin, C# and Python** CLIs learn where metadata lives.

**The decision, in one line: ship `sources` to all four ports now, hold `scope` back, and read a
declared neutral SUBSET of the config file rather than the whole schema.**

The requirement being served, as stated by the maintainer:

> the ports need not work exactly the same way, but they must be able to read all the same
> sources, and the `.metaobjects` config should be the default when nothing else is specified.

## 2. Decision 1 — `sources` and `scope` are separate deliveries

They were bundled in phase 1 because one TypeScript implementation served both. Cross-port they
are not one feature, and bundling them triples the cost of the half that is nearly free.

**`sources` is cheap.** Every port's loader already accepts a set of sources; only the CLI
convenience wrapper is single-directory:

| Port | Set-accepting loader entry | Single-dir wrapper |
|---|---|---|
| Java | `load(List<MetaDataSource>)` — `MetaDataLoader.java:1541`; also `setSourceURIs(List<URI>)` at `:994` | `:660` |
| C# | `Load(IReadOnlyList<IMetaDataSource>)` — `MetaDataLoader.cs:334` | `FromDirectory` `:93`, `:102` |
| Python | `load(sources: list[MetaDataSource])` — `meta_data_loader.py:102` | `from_directory` `:149` |
| TypeScript | (phase 1) | — |

`DirectorySource` exists in all four codebases (Kotlin inherits the JVM one). The work is CLI
plumbing plus a config reader, not engine work.

**`scope` is expensive, and it collides.** Java already ships a filter grammar, and it uses the
same characters for different meanings. From `GeneratorUtil.createRegexFromGlob`:

```java
case '*': out += ".*";     break;   // CROSSES :: — any depth
case '@': out += "[^:]+";  break;   // exactly one segment
case ':': out += "\\:";    break;   // TODO: This doesn't seem to work on enforcing the ::'s as a separator for *
```

Java's `@` is the new grammar's `*`; Java's `*` is the new grammar's `**`. Java additionally has
`!`-prefix exclusion (`:36-39`) and a `.[attr]` predicate suffix (`:72`) that `scope` cannot
express. The file carries a `TODO` conceding the separator handling is wrong.

The two are also the **same tier**, so they compete rather than layer:
`AbstractMetaDataMojo.java:161-165` merges loader-level and generator-level `<filters>` and hands
the union to the generator, and TypeScript's `scope` is documented as an "Output filter applied
across every command" (`config.ts:133`). Both filter output; neither filters the load.

**Therefore:** `scope` cross-port requires either a grammar migration for existing Java consumers
or two coexisting grammars. That is a decision with adopter impact, and it is not a prerequisite
for "read all the same sources." It is deferred to its own design (§8).

## 3. Decision 2 — the contract boundary

This is the part the maintainer's "need not work exactly the same way" licenses, and it needs to
be explicit or five ports will each guess.

### Identical across ports — this is the contract

1. **The resolved file SET.** Given the same `sources` and the same tree, every port resolves the
   same set of metadata files.
2. **The relative-path base.** A relative `path` resolves against **the directory holding the
   declaring `.metaobjects/` folder** — never against ambient cwd. Absolute paths are taken
   as-is. (TS: `resolveSpecPath`, `sources.ts:102-104`. Python already obeys this rule for its
   own key: `project_config.py:77-79` resolves `metadata` under `config_dir`.)
3. **Which file kinds count as metadata** when a directory is walked recursively.
4. **A declared source that does not exist is `ERR_SOURCE_UNRESOLVED`** — never a silent skip.
   Only the *default* may be absent, and then it is `ERR_COLLECTION_NOT_FOUND`.
5. **An unsupported source kind is `ERR_SOURCE_KIND_UNSUPPORTED`.** `resource` and `package` are
   declared in the shape but resolve in no port yet.
6. **A config file that exists but is malformed is an error** — it must never degrade to "no
   config". TypeScript already does this deliberately (`collection.ts:129-140`).
7. **The default when nothing is declared:** one `path` source named `metaobjects`
   (`metadata-files.ts:33`), and it is a default *value*, never a requirement.

### May differ per port — explicitly NOT the contract

1. **The ORDER of the resolved files.** It already diverges and always has: Java's
   `DirectorySource.expand()` sorts by basename (`DirectorySource.java:105`), C# by full-path
   ordinal (`DirectorySource.cs:64`), TypeScript walks depth-first with files-before-subdirs
   (`metadata-files.ts:101-121`). Making order a contract would be a behavior change in three
   ports for no gain: super-resolution is order-independent (#188) and the loader's overlay
   partition discards caller order. **Ports keep their existing walk order.**
2. **How the port is told to override** — a positional argument, a `--config` flag, a pom element.
3. **Whether the port has walk-up discovery** (§5).
4. **Config-file caching, error message wording, and diagnostics formatting.**

> **Known limit, stated rather than papered over.** An identical file *set* does not guarantee an
> identical loaded *model* — overlay partitioning and super-resolution sit downstream. This design
> gates the set. Model-level equivalence is what the existing metamodel conformance corpus gates,
> and the two are separate claims.

## 4. Decision 3 — read a neutral SUBSET, not the whole schema

`.metaobjects/config.json` is parsed by a `.strict()` zod schema that carries **TypeScript-owned
keys**: `pending_in_git`, `confidence_thresholds`, `extract.metaignore`, and `migrate`
(`config.ts:123-142`).

Requiring four ports to model those — or to reject a valid config containing them — is untenable
and would make every future TS-only key a four-port change.

**The rule:**

- The **neutral subset** is `schema_version`, `sources`, and (later) `scope`. It is specified in
  its own document and versioned by `schema_version`.
- The four ports **validate the subset strictly** and **ignore unknown top-level keys**.
- **TypeScript remains the only strict validator of the whole file, and the only writer.**

The cost is real and accepted: a key misspelled *outside* the subset is caught only by the Node
CLI. The alternative — four ports modeling `confidence_thresholds` — is worse.

## 5. Decision 4 — precedence, and what "default" means

The maintainer's "the `.metaobjects` config is default if nothing is specified" is read as
**fallback**, not authority. The ladder, per port, first match wins:

1. **An explicit CLI argument** — C#'s positional `<metadataDir>`, Python's positional
   `metadata_dir`, `--config`, `--cwd`. Wins outright.
2. **The port's native config surface**, when it names a metadata location — Java/Kotlin's pom
   `<sources>`/`<sourceDir>`, Python's `metadata` key in `metaobjects.config.yaml`.
3. **`.metaobjects/config.json`'s `sources`**, when present and non-empty.
4. **The built-in default** — one `path` source named `metaobjects`.

At every rung: **present but malformed is an error, not a fall-through to the next rung.**

**Precedence is whole-concern for `sources`.** A native surface either names a metadata location
or it does not. There is no per-entry merging of a pom's `<sources>` with the neutral file's —
that would be a five-way merge matrix, and merge matrices are what drift across five
implementations. With `scope` deferred (§2) the per-key question does not arise in this phase; it
must be answered by the `scope` design when it lands.

**Java's pom `<sources>` is not the neutral `sources`.** It lists individual metadata *documents*
(files, `resource:` classpath entries, `model:` URIs) resolved against `sourceDir`; neutral
`sources` is a set of *roots*. They are different primitives that happen to share a name. A pom
declaring either `<sourceDir>` or `<sources>` occupies rung 2 and the neutral file is not
consulted; neither element changes meaning.

## 6. Decision 5 — the writer gap is Node-side, not four writers

The gap §4.6 of the phase-1 design named: a JVM-rooted adopter scaffolded with `agent-docs` has
no `.metaobjects/config.json` at all, so the Node CLI's `migrate` has nothing to discover no
matter which ports can read.

**It does not follow that four ports need writers.** `migrate` and `verify --db` are Node-only
(ADR-0015), so the adopter who needs that file is by definition already invoking the Node CLI.
The missing piece is a *lighter* Node writer: `meta init` today scaffolds the full TypeScript
project (`metaobjects/`, `codegen/generators/`, `metaobjects.config.ts`, `.gitignore`,
`package.json` edits) and has no flag to write only the config (`init.ts:635-650` — the flags are
`force`, `quiet`, `printOnly`, `refreshDocs`, `d1`).

**Decision: add a config-only mode to the Node `meta init`.** It writes `.metaobjects/config.json`
and nothing else, so a Maven- or pip-rooted project can declare its sources for the Node CLI
without acquiring a TypeScript scaffold it will not use. Four port writers stay out of scope.

## 7. Conformance — a new corpus, and an honest note about its reach

`fixtures/scope-conformance/` has 10 cases and **exactly one runner**
(`server/typescript/packages/sdk/test/scope-conformance.test.ts`). A corpus with one runner pins
nothing cross-port. Since `scope` is deferred, that corpus stays as-is and gains runners with the
`scope` design.

**This phase adds `fixtures/source-resolution-conformance/`**, gating §3's identical column:
the resolved file **set** (order-insensitively), the relative-path base, the default-when-absent,
and each error condition. Every port ships a runner in the same changeset as its reader.

> **A limitation to record rather than discover later.** The non-TypeScript lanes do not run on
> pull requests — they run on push-to-`main`, release tags, and manual dispatch
> (`AGENTS.md:91-92`). So this corpus has the same detection latency as the code it gates: it
> cannot catch a divergence *before* merge. It is a regression gate, not a review gate. That is
> the standing reason the four readers ship in one changeset rather than one port at a time.

## 8. Deferred, with the reason

- **`scope` cross-port** — blocked on the grammar collision (§2). Needs its own design answering:
  migrate Java consumers, or run two grammars? Until then `scope` stays TypeScript-only and no
  cross-port behavior may depend on it.
- **`resource` and `package` source kinds** — declared in the shape, resolving nowhere. `resource`
  (classpath) is JVM-natural and unreachable from Node; `package` needs the distribution ADR
  (prior art P5: no surveyed project publishes one code-free schema artifact to four registries).
- **Named collections** — the phase-1 design's §6 deferral is unchanged.
- **Walk-up discovery in the non-TS ports.** None has it today (Python's `_find_config` is
  cwd-only, `cli.py:192-201`; C# has no config surface; Java uses the Maven reactor, which makes
  discovery a non-issue for codegen). Ports read the config file at their already-known project
  root. Adding a walk is a separate, additive change.

## 9. What was checked, and what was not

Verified in the repository at commit `19e421927` while writing this document: every file:line
citation above. The loader entry points, the `GeneratorUtil` grammar, the filter-merge site, the
per-port `DirectorySource` sort orders, the config schema's key list, the malformed-config
behavior, the `meta init` flag set, Python's `metadata` key and its cwd-only config lookup, and
the absence of any Kotlin CLI entry point (`fun main` appears in neither `metadata-ktx` nor
`codegen-kotlin` — Kotlin is Maven-only, so there are **four** CLI surfaces, not five).

Also verified, after the first draft of this document listed it as an open risk: **all four ports
already agree on which extensions count as metadata** — `.json`, `.yaml`, `.yml`, matched
case-insensitively (`DirectorySource.java:61`, `DirectorySource.cs:29-30`,
`directory_source.py:16`, `metadata-files.ts:52`). §3's identical-item 3 is therefore a property
the ports already hold, not one the plan has to establish. It still gains a corpus case, because
nothing currently pins it.

Nothing else in §3's identical column is known to diverge today, with the single exception of
file *order*, which §3 places explicitly outside the contract.
