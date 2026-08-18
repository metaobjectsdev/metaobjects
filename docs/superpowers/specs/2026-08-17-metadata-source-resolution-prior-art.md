# Metadata source resolution — prior art

_Status: RESEARCH (evidence for a design; contains no decisions)._
_Date: 2026-08-17._
_Feeds: the metadata-collection / source-resolution design (supersedes the scope of
`2026-06-11-fr-023-metadata-packages-design.md`, which is one resolver within it)._

## Why this document exists

MetaObjects needs to answer four questions it has never answered uniformly across its
five ports:

1. **What is a metadata collection?** Today a run loads exactly one directory (`metaobjects/`)
   in four of five ports. A monorepo with several apps sharing a common model cannot express
   itself.
2. **How does a tool know which collection it is working in?** A CLI invoked at a monorepo
   root sees only the root's metadata, which is the wrong answer for an app three directories
   down.
3. **How is a shared model distributed and depended upon** across repos and across languages
   (npm / PyPI / NuGet / Maven — or something else)?
4. **Can a source be remote** (a URL, an OCI artifact, a database) and if so, at build time,
   at runtime, or both?

Every one of these has been solved, several times, in public, by projects with the same
shape: a declarative model, a toolchain that reads it, multiple languages downstream, and
users with monorepos. This document records what those projects actually do, so the design
argues from evidence rather than from first principles.

## Sourcing and IP hygiene

Rules followed while compiling this:

- **Open-source projects only.** Every project surveyed ships its tool under an OSI-approved
  license, and every behavior described is from that project's **public documentation**.
- **Behavior and public config grammar only.** No source code was read, copied, or adapted.
  Descriptions are written from scratch in our own words; nothing is quoted at length.
- **Hosted/commercial components are explicitly excluded.** Several of these projects pair an
  open-source CLI with a commercial hosted registry. Only the open-source CLI's *local
  configuration and resolution behavior* is recorded here. The hosted services' internals,
  APIs, and pricing models are out of scope and were not investigated.
- **Every claim carries a URL.** Claims marked _(background)_ are widely-known, long-standing
  toolchain behavior (the Java classpath, `sys.path`, nearest-ancestor config discovery) that
  was not re-verified against a citation in this pass; they are included for completeness of
  the pattern and should not be treated as researched findings.
- **Licenses are noted per project.** Where a project's license changed (Terraform), that is
  called out along with its OSS fork, so nothing here is mistaken for guidance to depend on a
  non-OSS artifact.

This document describes *patterns*, which are not protectable. It is a survey, not a
derivative work.

---

## Part 1 — The seven recurring patterns

### P1. The ordered root list ("include path")

The oldest and most durable shape: a tool is given an **ordered list of roots**, and a
reference is resolved by trying each root in order until one matches.

- **protoc** takes one or more `--proto_path` / `-I` roots. An `import` is resolved relative
  to each root **in order, first match wins** — the documented idiom being to put a local
  tree ahead of a vendored tree so a local override shadows a dependency.
  ([protoc reference](https://protocolbuffers-protobuf-45.mintlify.app/tooling/protoc),
  [Go Protobuf Tips](https://jbrandhorst.com/post/go-protobuf-tips/); protobuf is BSD-3-Clause)
- The **Java classpath**, Python's **`sys.path`**, and Ruby's **`$LOAD_PATH`** are the same
  primitive: an ordered sequence of roots, resolved left to right. _(background)_

**Why it matters here:** MetaObjects' Java port already implements exactly this — the Maven
plugin's loader parameter takes a `sourceDir` plus an **ordered list** of sources. The other
four ports collapsed it to a single directory. This is not a new idea to invent; it is an
existing idea to propagate.

**The subtlety worth stealing:** first-match-wins over an ordered root list, and
last-writer-wins overlay merge (MetaObjects' existing semantics), are *different* composition
rules. protoc shadows a whole file; MetaObjects merges node-by-node. A design that borrows the
ordered list must say explicitly which rule applies at which layer.

> **CORRECTION (added on review — this pattern does NOT apply, and leading with it was a
> mis-generalization).** Every example in P1 is a **shadowing** mechanism: order encodes
> precedence and the losing file is discarded entirely. MetaObjects *merges*. Adopting an ordered
> include path would therefore import order-sensitivity that the engine has already engineered
> away — super-resolution is a pure function of the source *set*, and the loader already discards
> the caller's declared order in the one place it matters (it reads every source, classifies each
> base-vs-overlay, and reorders). P1 is the oldest pattern here and the **least** applicable. See
> P8, which is what the dependency-management prior art actually shows.

### P2. Collection identity, and a workspace of N collections

Once there is more than one collection, each needs a name, and something has to describe the
set.

- **Buf v2** merged what were previously two files into one: a single `buf.yaml` at the
  workspace root declares **multiple modules**, each with its own directory and its own
  lint/breaking-change settings, while **external dependencies and the lock file are shared
  across the whole workspace**. Critically, **dependencies *between* modules in the workspace
  are not declared** — the tool infers them from the module set. One publish command covers
  every module in dependency order.
  ([modules and workspaces](https://buf.build/docs/cli/modules-workspaces/),
  [v2 migration guide](https://buf.build/docs/migration-guides/migrate-v2-config-files/);
  the Buf CLI is Apache-2.0 — [repo](https://github.com/bufbuild/buf))
- **Cargo** defines a workspace via a `[workspace]` section in a `Cargo.toml`, which may be a
  "virtual" manifest (workspace only, no package of its own) or a real one (both). Members are
  listed as glob patterns, and the workspace shares one lock file and one build output
  directory. ([Cargo workspaces](https://deepwiki.com/rust-lang/cargo/2.2-workspaces);
  Cargo is MIT OR Apache-2.0)
- **Go workspaces** take the opposite stance on discovery: a `go.work` file lists module
  directories by **explicit relative path**, and Go deliberately does **not** auto-discover
  modules — you add them with an explicit command. Absent a `go.work`, the workspace is simply
  the single module containing the current directory.
  ([Go modules reference](https://go.dev/ref/mod); Go is BSD-3-Clause)

**The design fork this exposes:** glob-based auto-discovery (Cargo, Buf) versus explicit
enumeration (Go). Go's rationale — no surprises, no accidental membership — is the stronger
argument in a polyglot repo where a stray directory could otherwise be swept into a build.

### P3. Contextual discovery — nearest ancestor, plus an explicit override

Every tool in this space eventually needs to answer "which project am I in?" and they all
converge on the same two-part answer.

- **graphql-config** supports both shapes and says so explicitly: either multiple named
  `projects` in one root config, **or** one config file per subdirectory, where the config
  file's location defines a scope for its whole subtree. Their framing is the clearest
  statement of the principle — a config file marks a module root the same way `package.json`
  does, and editor tooling picks the config **closest in the directory hierarchy** to the file
  being worked on. ([graphql-config usage](https://the-guild.dev/graphql/config/docs/user/usage);
  graphql-config is MIT)
- **dbt** defaults to looking for its project file in the current working directory **and its
  parents**, with an explicit `--project-dir` flag (and an environment variable) to override.
  ([dbt_project.yml reference](https://docs.getdbt.com/reference/dbt_project.yml);
  dbt-core is Apache-2.0)
- `tsconfig.json`, `.editorconfig`, `.gitignore`, and `package.json` all use nearest-ancestor
  resolution. It is the least surprising behavior in developer tooling. _(background)_

**The consistent shape: walk up from cwd to find the nearest collection root; allow an
explicit flag to name one; allow a root config to enumerate several.** No surveyed project
requires the user to pass a path on every invocation, and none auto-detects without an escape
hatch.

### P4. How a source is spelled — three grammars

Three distinct approaches to writing down "where this dependency comes from":

- **Prefix-disambiguated single string (Terraform).** One `source` string covers local paths,
  a module registry, Git, HTTP, and object storage. The kinds are told apart by *syntax*: a
  local path **must** begin with `./` or `../` (which is what distinguishes it from a registry
  address), Git sources carry a `git::` prefix, registry addresses use a
  `namespace/name/provider` shape. Local paths are explicitly *not* "installed" — they are used
  in place. ([module sources](https://developer.hashicorp.com/terraform/language/modules/sources))
  **License note:** Terraform moved to BUSL-1.1 in 2023. Only its publicly documented
  configuration grammar is described here; the MPL-2.0 fork **OpenTofu** carries the same
  grammar and is the OSS artifact to reference if this pattern is adopted.
- **Tagged union (dbt).** Dependencies are declared as a list where each entry names its kind
  by key — a registry package, a Git repo, or a **local path**. dbt's documentation
  specifically recommends **local packages as the monorepo answer**: several projects nested in
  subdirectories, combined for coordinated development and deployment.
  ([dbt packages](https://docs.getdbt.com/docs/build/packages))
- **Ecosystem coordinates (Smithy).** `smithy-build.json` declares model dependencies as
  **Maven GAV coordinates** plus repository URLs, and the CLI resolves them with the actual
  Apache Maven dependency resolver. Shared models are published *inside a JAR* via a dedicated
  packaging plugin that adds the model files and build metadata to the jar.
  ([smithy-build.json](https://smithy.io/2.0/guides/smithy-build-json.html),
  [Gradle plugins](https://smithy.io/2.0/guides/gradle-plugin/index.html); Smithy is Apache-2.0)

**Smithy is the closest precedent for MetaObjects' instinct** — a schema-first, multi-language
codegen tool that resolves its *model* dependencies through an existing language package
manager rather than inventing distribution. Note what it did **not** do: see P5.

**The trade-off:** a single prefix-disambiguated string is terse but forces the parser to own a
grammar and makes ambiguity a real failure mode (Terraform needs the `./` rule precisely
because of it). A tagged union is verbose but self-documenting, machine-checkable, and
extensible without touching a parser — which matches how MetaObjects already treats its own
config (`ADR-0037`'s bias toward self-documentation over economy).

### P5. Distribution channel — the three-way split, and a notable negative

This is where the surveyed projects disagree most sharply, and the disagreement is informative.

- **Own registry (Buf).** Built a dedicated schema registry; the CLI's `deps` name modules in
  it, and every commit is content-addressed by a cryptographic manifest digest recorded in the
  lock file. ([dependency management](https://buf.build/docs/bsr/module/dependency-management/))
  The hosted registry itself is a commercial service and is out of scope here; what is relevant
  is that Buf chose *not* to ride existing language registries.
- **Existing language registry, one ecosystem only (Smithy).** Uses Maven — and only Maven —
  even though Smithy generates code for many languages. The model artifact is a JAR regardless
  of which language you generate.
- **OCI registries (CUE).** CUE's module system is built on **OCI registries** rather than
  ecosystem-specific ones. The stated reasoning is directly on point for a polyglot standard:
  nearly every deployment already has an OCI registry available, the protocol is HTTP-based and
  simple enough to implement a custom server against, and it is an open standard — so a single
  artifact serves every language instead of N per-ecosystem copies of the same bytes.
  ([CUE modules](https://cuelang.org/docs/reference/modules/),
  [custom module registry](https://cuelang.org/docs/tutorial/working-with-a-custom-module-registry/),
  [modules design proposal](https://github.com/cue-lang/proposal/blob/main/designs/modules.v3/2939-modules.md);
  CUE is Apache-2.0)

**The negative finding, stated plainly: no surveyed project publishes the same code-free
schema artifact to four language registries.** Every one either built its own registry, picked
a single ecosystem, or moved to OCI. CUE faced precisely MetaObjects' situation — a polyglot
declarative language needing cross-language model reuse — and explicitly rejected the
per-ecosystem approach.

This does not make the four-registry plan wrong. MetaObjects already publishes to all four
registries in lockstep, so the release machinery exists and the marginal cost of a fifth
code-free artifact per registry is lower here than it would be for a greenfield project. But
it does mean the plan should be an **argued decision** rather than an assumption, and the
argument has to address what CUE's reasoning gets right: four artifacts of identical bytes
have four version numbers, four resolvers, four caches, four lockfiles, and four opportunities
to drift.

### P6. Pinning and reproducibility

Every surveyed project separates **declaration** from **resolution**, and records the
resolution.

- **Buf** pins each dependency in a lock file by content-addressed digest, not merely by
  version. ([dependency management](https://buf.build/docs/bsr/module/dependency-management/))
- **Cargo** shares one lock file across the entire workspace.
  ([workspaces](https://deepwiki.com/rust-lang/cargo/2.2-workspaces))
- **Terraform** and **dbt** each have an explicit install/fetch step separate from use; dbt
  vendors resolved packages into a local directory. ([dbt packages](https://docs.getdbt.com/docs/build/packages))
- Local-path sources are the documented exception in both Terraform and dbt: they are **not
  installed**, they are read in place.

**The pattern: remote sources get an explicit fetch step and a pinned record; local sources
skip both.** No surveyed tool silently fetches a remote dependency during a normal build.
This has a direct consequence for MetaObjects: a URL source that is read at load time, on every
`meta gen`, with no lock and no cache, is a shape nobody in this space ships.

### P7. Build-time versus runtime is a hard boundary

Two entirely separate worlds, and no surveyed project blurs them.

- **Build-time** distribution (everything in P5) resolves files onto disk before codegen runs.
- **Runtime** schema access is a different product category — a schema registry service
  queried over HTTP by a running application, addressing artifacts by group/id/version and
  returning the schema document. **Apicurio Registry** (Apache-2.0) is the open-source
  reference: a REST interface where a client fetches a specific artifact version at runtime.
  ([Apicurio introduction](https://www.apicur.io/registry/docs/apicurio-registry/3.1.x/getting-started/assembly-intro-to-the-registry.html),
  [artifact reference](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-artifact-reference.html))

**Relevance to "sourcing from a DB":** in every surveyed system, reading schema from a live
service or store is a **runtime** capability serving a running application — not a build-time
codegen input. A database as a *codegen* source would be novel, and novelty here is a cost:
it breaks reproducible builds (the source can change between two builds of the same commit)
unless paired with the P6 pin-and-cache discipline. A database as a *runtime* source is
well-trodden and is a different feature with different requirements.

### P8. Nobody makes the user declare load order

_Added on review, and it reverses P1's framing._

Re-read for order-sensitivity rather than for structure, the dependency-management prior art is
unanimous: **the user declares a SET, and the tool derives whatever order it needs.**

- **Buf** is the most explicit: dependencies *between* modules in a workspace are deliberately not
  declared, because the tool infers them from the module set — and a single publish covers every
  module in the right dependency order, computed rather than written down.
  ([modules and workspaces](https://buf.build/docs/cli/modules-workspaces/))
- **Go**, **Cargo**, **dbt** and **Terraform** all take an unordered dependency declaration and
  compute the graph. Nobody hand-sorts a `go.mod`, and dbt builds its DAG from model references
  rather than from list position. ([Go modules](https://go.dev/ref/mod),
  [Cargo workspaces](https://deepwiki.com/rust-lang/cargo/2.2-workspaces),
  [dbt packages](https://docs.getdbt.com/docs/build/packages))
- **Smithy** hands its coordinates to the Maven resolver, which owns ordering entirely.

The only ordered-list examples in this document (P1) are shadowing mechanisms, where order *is* the
precedence rule rather than a load sequence.

**Implication:** a config schema that asks an author to sequence sources is asking for information
no surveyed tool requires and this engine does not consume. Precedence, where it is genuinely
needed, should be expressed as a **rule attached to a source** ("a local source wins over a
dependency") rather than as a position in a list — which also makes diamond dependencies, parallel
resolution, and incremental addition fall out for free.

### P9. Scoping is done with patterns, not predicates

Every surveyed tool that scopes a large model scopes it with **declarative string patterns** —
never a callback. Buf modules take path `excludes`; Smithy's build config filters models
declaratively; dbt selects with a string selector syntax.

MetaObjects' own Java port has carried this since long before this survey: `GeneratorUtil`
implements include/exclude patterns (a `!` prefix marks an exclusion) glob-matched against a node's
fully-qualified name, with `@` matching exactly one package segment.

**Implication:** a predicate *function* — TypeScript's per-generator `filter` — cannot be expressed
in a YAML config, an XML pom, or a CLI flag, and cannot be gated by any cross-language corpus. It
is therefore unsuitable as a cross-port primitive regardless of its ergonomics in the one port that
can express it.

---

## Part 2 — Evidence table

| Project | License | Ordered roots | Multi-collection config | Contextual discovery | Dep grammar | Distribution | Pinning |
|---|---|---|---|---|---|---|---|
| protoc | BSD-3-Clause | **yes**, first-match-wins | — | — | — | — | — |
| Buf CLI | Apache-2.0 | — | **one config, N modules**, shared deps, intra-workspace deps inferred | workspace root | module refs | own registry | digest lock |
| Cargo | MIT OR Apache-2.0 | — | `[workspace]` + member globs | walk up | coordinates | crates.io | one workspace lock |
| Go modules | BSD-3-Clause | — | `go.work`, **explicit paths, no auto-discovery** | single module containing cwd | module paths | VCS-addressed | `go.sum` |
| graphql-config | MIT | — | `projects` map **or** per-subtree config | **nearest ancestor** | — | — | — |
| dbt-core | Apache-2.0 | — | local packages = the monorepo answer | walk up + `--project-dir` | **tagged union** (registry/git/local) | package registry | vendored install step |
| Smithy | Apache-2.0 | — | — | — | **Maven GAV** | **Maven JAR** (one ecosystem) | Maven resolver |
| CUE | Apache-2.0 | — | modules | module root | module paths | **OCI registries** | module resolution |
| Terraform | BUSL-1.1 (fork: OpenTofu, MPL-2.0) | — | — | — | **prefix-disambiguated string** | multi-scheme | lock file |
| Apicurio Registry | Apache-2.0 | — | — | — | group/id/version | — | **runtime**, not build |

---

## Part 3 — What the evidence says about MetaObjects specifically

Findings, not decisions. Each is a question the design must answer explicitly.

1. **~~The ordered-list-of-roots primitive is settled prior art~~ — REVISED.** The Java port's
   loader does take an ordered source list plus a URI grammar covering file, URL and classpath
   resource, and four ports collapsed that to one directory, so propagation is still the job. But
   the *ordering* half should not be propagated: per P8 no surveyed tool asks the author to
   sequence anything, and per P1's correction this engine already ignores the declared order.
   Propagate the multi-source capability and the `resource` kind; drop the sequence.

2. **Collection identity is tooling config in every surveyed project — never part of the
   schema language itself.** Buf, Cargo, Go, dbt, and graphql-config all keep "what is a
   collection and where does it live" in a config file, entirely outside the modeled types.
   That is direct evidence against introducing a `collection` node into the MetaObjects
   metamodel, and in favor of the config layer — which also keeps `registry-conformance` and
   ADR-0023 out of it.

3. **Contextual discovery has one converged answer: nearest ancestor, plus an explicit
   override, plus optionally a root config enumerating several collections.** graphql-config
   ships all three shapes and documents when each applies. MetaObjects' CLI already has the
   override (`--cwd` / a project-root positional); it is missing discovery.

4. **Go's explicit-enumeration stance deserves weight over Cargo/Buf globbing**, because a
   polyglot repo has more directories that merely *look* like collections, and silent
   membership is the failure mode that is hardest to debug.

5. **Local-path sources are the recommended monorepo mechanism in the two projects that
   address monorepos head-on** (dbt explicitly; Terraform by giving local paths their own rule).
   Both treat local paths as read-in-place, never installed. This is the shape the blocked
   adopters need, and it is the cheapest thing in this document to ship.

6. **The four-registry distribution plan is unprecedented among surveyed peers and needs an
   argued decision.** The counter-evidence (CUE's explicit rejection, Buf's own registry,
   Smithy's single ecosystem) is strong enough that "publish to all four" should be recorded as
   an ADR with the reasoning, or reconsidered in favor of OCI — noting that MetaObjects'
   existing four-registry lockstep release machinery is a genuine advantage none of these
   projects had.

7. **Remote sources need a fetch step and a pin. No surveyed tool reads a remote source inline
   during a normal build.** A URL source resolved on every `meta gen` would be a novel shape,
   and the novelty is a reproducibility cost, not a feature.

8. **A database source is a runtime pattern, not a build-time one.** Splitting it out of the
   build-time design entirely is consistent with every system surveyed.

9. **The Buf workspace precedent does not transfer — verified by spike, not by reading.** Buf can
   declare N modules and their consumers in one root file because **Buf owns its entire config
   surface**. MetaObjects does not: the *build tool* owns it, and a consumer's generator wiring
   already lives in `metaobjects.config.ts` or a `pom.xml`. A root config enumerating consumers
   would have to duplicate or override those. Buf's *module-set* idea transfers; its *single root
   config* does not. Recorded because the structural precondition, not the shape, is what decides
   whether a borrowed pattern works.

10. **Scoping should be package patterns, and MetaObjects already has the reference
    implementation** (P9) — in the same port that has the multi-source list, and for the same
    reason: it is the only port whose adopters hit these problems at scale.

---

## Sources

All URLs are public documentation, retrieved 2026-08-17.

- protobuf / protoc — [compiler reference](https://protocolbuffers-protobuf-45.mintlify.app/tooling/protoc) · [include-path ordering idiom](https://jbrandhorst.com/post/go-protobuf-tips/) · [files and packages](https://buf.build/docs/reference/protobuf-files-and-packages/)
- Buf CLI — [modules and workspaces](https://buf.build/docs/cli/modules-workspaces/) · [v2 config migration](https://buf.build/docs/migration-guides/migrate-v2-config-files/) · [dependency management](https://buf.build/docs/bsr/module/dependency-management/) · [repo (Apache-2.0)](https://github.com/bufbuild/buf)
- Cargo — [workspaces](https://deepwiki.com/rust-lang/cargo/2.2-workspaces)
- Go modules — [reference](https://go.dev/ref/mod)
- graphql-config — [usage](https://the-guild.dev/graphql/config/docs/user/usage) · [multi-project config](https://the-guild.dev/graphql/codegen/docs/config-reference/multiproject-config)
- dbt — [packages](https://docs.getdbt.com/docs/build/packages) · [dbt_project.yml](https://docs.getdbt.com/reference/dbt_project.yml) · [project dependencies](https://docs.getdbt.com/docs/mesh/govern/project-dependencies)
- Smithy — [smithy-build.json](https://smithy.io/2.0/guides/smithy-build-json.html) · [Gradle plugins](https://smithy.io/2.0/guides/gradle-plugin/index.html)
- CUE — [modules reference](https://cuelang.org/docs/reference/modules/) · [custom module registry](https://cuelang.org/docs/tutorial/working-with-a-custom-module-registry/) · [modules v3 design proposal](https://github.com/cue-lang/proposal/blob/main/designs/modules.v3/2939-modules.md)
- Terraform — [module sources](https://developer.hashicorp.com/terraform/language/modules/sources)
- Apicurio Registry — [introduction](https://www.apicur.io/registry/docs/apicurio-registry/3.1.x/getting-started/assembly-intro-to-the-registry.html) · [artifact reference](https://www.apicur.io/registry/docs/apicurio-registry/3.3.x/getting-started/assembly-artifact-reference.html)
