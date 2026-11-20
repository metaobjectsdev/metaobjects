# ADR-0065: Rust is the sixth port

## Status

**Accepted** (2026-11-19). Registers no vocabulary: `metamodelVersion` is unchanged. Adds a sixth
language port under `server/rust/`, in preview, and a `rust` CI lane. Amends nothing.
**Amendment 1** (2026-11-19) records the command line, the shape of the generated crates and the
`client` and `commands` generators.

## Context

MetaObjects ships five ports (TypeScript, Java, Kotlin, C#, Python), each held to the others by
the shared conformance corpora rather than by a claim in prose. Rust is the obvious missing
server language: it is where a growing share of new backend and tooling work is written, and a
generator written in it is fast enough that regenerating a large model stops being something an
adopter waits for.

A port is a large, long-lived commitment, so the question is not only "should there be one" but
"what does it promise while it is incomplete, and where does it deliberately differ from the other
five".

## Decision

1. **Rust is a full port, built in phases, and it is in preview until it leaves preview by
   decision.** It ships the same core as the others (ADR-0034 Amendment 3): the metamodel,
   loader, canonical serializer and registry, then runtime metadata access, `verify`, prompt
   render and the reply parser. Its generators are reference helpers like every other port's,
   and it can eject them. The first slice is the loader core, gated by `registry-conformance`
   (byte-identical) and the shared metamodel corpus.

2. **Layout.** `server/rust/` is one Cargo workspace with a pinned toolchain
   (`rust-toolchain.toml`). Three crates, each with code: `metaobjects` (node model, registry,
   providers, loader, serializer), `metaobjects-codegen` (the run engine and the generators) and
   `metaobjects-cli` (the `cargo-meta` binary). The workspace carries no empty placeholder crates;
   a crate joins it with its first code.

3. **The command is `cargo meta`.** It is a Cargo subcommand (a `cargo-meta` binary), the way the
   other build-tool-hosted ports spell theirs (`dotnet meta`, `mvn metaobjects:...`). A bare `meta`
   stays the Node schema CLI's.

4. **Preview, on a 0.x line, unpublished.** The crates are `publish = false` and nothing goes to
   crates.io until the port leaves preview. When it publishes, it starts on its own `0.x` line
   rather than joining the lockstep npm/Maven/PyPI/NuGet numbers, the way the source-only Angular
   packages keep their own line (ADR-0048). It joins the convergent-publishing rule
   (ADR-0035 Amendment 1) when it leaves preview.

5. **Conformance is the definition of done, and gaps are ledgered, not hidden.** The metamodel
   runner keeps an expected-failures ledger in the format the other ports use. A fixture on the
   ledger that starts passing fails the run until it is removed, so the ledger can only shrink.
   While the port is in preview, a fixture that is not on the ledger and fails in Rust prints a
   warning naming the fixture and the reason, and does not fail the run or the `rust` lane, so a
   new conformance fixture in a 1.3.0 PR never turns the lane red for a port that has not built
   that behavior yet. A regression is still a failure: the ledger records `minPassing`, the number
   of fixtures known to pass, which may only rise, and the run fails when fewer pass. When the
   preview label comes off, an unlisted failure fails the lane.

6. **Deliberate differences from the other five.**
   - **No `migrate`.** Schema migrations are TypeScript-owned (ADR-0015), as in Java, C# and
     Python. The Rust CLI is codegen, `verify` and `fmt`.
   - **Jinja is refused.** Template bodies render with the Mustache engine every port shares; a
     Jinja body is refused with `ERR_TEMPLATE_ENGINE_UNSUPPORTED`, as in Java, Kotlin and C#
     (ADR-0061).
   - **Generated code is one crate per MetaObjects package.** A Rust crate is the unit of
     compilation and visibility, so a package maps to a crate rather than to a module of one
     large crate. Cross-package references become crate dependencies.

7. **Built for speed from the start.** Generation writes only files whose bytes changed, keeps
   no per-file manifest writes on the hot path, and runs no formatter in the generation path
   (the emitter writes formatted output, as ADR-0063 rules for every port). A load benchmark over a 20-times copy of the public
   fitness model (`cargo run --release --example load_bench`) is kept beside the crate, and
   `gen_bench` (in `metaobjects-codegen`) times generation per stage on the same model.

8. **The runtime read path: freeze, then memoize, like the other ports.** Runtime metadata
   access reads the same resolved values over and over from many threads, so the tree caches its
   `extends`-chain walks the way TypeScript (`cached()`), C# (`Cached<T>`), Python (`_cached`) and
   Java (`freeze()`/`useFrozenCache()`, FR-031) do. A tree has a mutable load phase and a frozen
   phase. The loader calls `Tree::freeze()` at its terminal phase (where the other ports freeze at
   REGISTERED); from then on every mutator panics, and the resolving accessors memoize: one
   `OnceLock` per node and accessor, allocated at the freeze. Nothing is cached before the freeze,
   so a value read during the load cannot be served stale, and nothing is invalidated. A frozen
   `Tree` is `Sync`; a racing first read computes an entry once while the others wait, and a
   cached read returns a borrow (`Cow::Borrowed`) rather than a copy.

   The memoized set is the base-node set the other ports share: effective `children`, effective
   `attrs` (and `attr`, which reads through that map once frozen) and `resolved_is_array`.
   TypeScript and C# also cache snapshots of a node's own attrs and own children because they
   copy them; the Rust own accessors already borrow the node's storage, so there is nothing to
   memoize. Typed accessors that come with later phases (an object's fields, identities and
   relationships, a root's object lookup) memoize through the same per-node cache, keyed the way
   the other ports key theirs. Tests in `node.rs` hold the cached reads equal to the uncached
   walks, prove a read before the freeze does not survive a later mutation, and read one frozen
   tree from eight threads at once.

## Consequences

- The shared lane map (`scripts/ci-lane-map.txt`, read by `scripts/ci-select-lanes.sh`) has a
  `rust` lane, `server/rust/**` selects it, and the `scripts/ci-affected-ports.sh` and
  `scripts/ci-ports-to-run.sh` selectors know six ports. `scripts/ci-local.sh --only rust` runs
  `cargo fmt --check`, clippy with warnings denied, the workspace's tests and the benchmark
  tables (record only), and `pr-ci` and `local-ci` run it as their own job. The lane's exact
  contents are owned by `scripts/ci-local.sh`.
- `docs/CONFORMANCE.md` names the port beside the matrix, not as a column, until it leaves
  preview; its column then appears with per-corpus results like the others.
- Every later phase (validation passes, overlays and cross-package references, YAML and source
  resolution, runtime access, codegen, `cargo meta`) is held to the same corpora the other ports
  run, and lands as its own change.

## Alternatives considered

- **Bindings over an existing port** (calling the TypeScript or Java loader from Rust). Rejected:
  it adds a second runtime to every adopter's build and gives up the speed that is part of the
  reason for the port.
- **A Rust core shared by the other ports.** Out of scope: every port owns its loader by design,
  and the corpora, not a shared binary, keep them identical.

## Amendments

### Amendment 1 (2026-11-19) — the command line, the generated crate shape, and the `client` and `commands` generators

Phase 2 gives the port a command a Rust developer can run the whole codegen loop with: `cargo meta
init`, `gen`, `verify --codegen` and `eject`, and three generators (`entity`, `client`, `commands`).
Three of the rulings below are the owner's; the rest are the design calls the work forced, recorded
so they are not re-derived.

**Owner rulings.**

1. **`commands` is Rust-only for now.** No other port ships a generator that writes command-line
   commands. It is not a hidden gap: the shared generator registry
   (`fixtures/generator-registry-conformance/registry.json`) lists `commands`, and `client` beside
   it, with `rust` as the only port. A port that adopts either name adds itself to that entry and
   the name is then shared like the others.
2. **No generator plugin contract for now.** Nothing discovers or loads a third-party generator.
   A project changes generation by owning a copy (ruling 5), and the engine's Rust API carries no
   stability promise while the port is in preview.
3. **Rust stays preview and unpublished.** Decision 4 stands unchanged. `cargo meta` is installed
   from a checkout (`cargo install --path`).

**The command line.**

4. **`cargo meta` follows the contract the other ports' tools share**
   (`docs/features/cli.md`): exit 0 on success, 1 when the run failed (a model that does not load,
   a refused file, drift), 2 for a usage error; an unknown flag names the flags the command takes.
   `verify` is the one verb of ADR-0021 D2, and `--codegen` is the only gate this port ships, so a
   bare `verify` runs it. `--db`, `--templates` and `--deps` exit 2 and say where that check lives.
   This corrects Decision 6, which listed `fmt`: the command today is `init`, `gen`, `verify
   --codegen` and `eject`. `fmt` and the template gate come with the phases that need them.
   **No `migrate` and no `verify --db`, permanently** (ADR-0015): `init` and `--help` both say that
   the schema is the Node `meta` tool's.
5. **An owned generator is a crate the project builds.** Rust is compiled, so a generator cannot
   be loaded from its source at run time. `cargo meta eject <name>` writes `codegen/Cargo.toml`
   and `codegen/main.rs` (once, then the project's) and `codegen/generators/<name>.rs`; while that
   crate exists, `gen` and `verify` build and run it, so there is one way to generate
   (ADR-0034 Amendment 9). A copy is the shipped source byte for byte, which is possible because
   the shipped generators name the engine by its crate name and never `crate::`. The engine
   surface an owned copy may import is `metaobjects_codegen::{emitted, generator, names, plan,
   writer}`, recorded in the registry's `eject.engineSurface.rust` and held by the port's test of
   the eject contract (ADR-0034 Amendment 8). Nothing is recorded about an eject: what a project
   owns is what is on disk, and `--undo` removes only copies still identical to the shipped source.
   Every file of the owned crate is an input of the skip key (ADR-0064), not only the ones `eject`
   writes, since the generator list is the project's file and may pull in any module beside it; the
   crate's build directory and lockfile are not. A build of the owned crate that fails, or a
   generator in it that panics, exits 1: the command keeps the shared 0, 1, 2.
6. **A hand-edited generated file is refused, by name.** There is no three-way merge, as in every
   port but TypeScript. The same rule covers the orphan sweep: a generated file nothing emits any
   more is removed, unless it was edited, in which case the run fails and names it.

**The generated crates.**

7. **One crate per package, per generator, and the shared code is generated too.** For a package
   `shop`: `shop` (`entity`), `shop_client` (`client`) and `shop_cli` (`commands`), plus one shared
   crate per generator: `meta_support` (exact decimals, durations, patch helpers, validation
   checks), `meta_client` (the HTTP transport) and `meta_cli` (body and query helpers). The
   generated crates import ordinary crates.io crates and nothing from MetaObjects. Considered and
   rejected:
   - *One crate per package with Cargo features for the client and the commands.* A crate is one
     compilation unit: a model change would rebuild the client and the commands with it, and a
     consumer of the model alone would carry `reqwest` and `clap` in its lockfile.
   - *A published MetaObjects support crate.* Nothing is published (ruling 3), and generated model
     code that imports MetaObjects would break the promise the other ports' entity tier keeps.
   - *The support code copied into every model crate*, which is what the first slice did. Two
     crates would then each have their own `Decimal`, so a value could not cross a package
     boundary without a conversion.
   The text of each shared crate is held inside the generator that writes it, so an owned `client`
   owns its transport.
8. **Types follow the wire, and Rust's own standard where it has one.** `decimal` is an exact
   decimal held as text and always written as the portable string: Rust has no standard decimal
   type, so `wire.decimals` has nothing native to select. `duration` is a signed ISO-8601
   duration. `inet` is `std::net::IpAddr`. `date`, `time`, `timestamp`, `uuid` and `uri` stay
   `String`, as they are on the wire, and `validate()` checks their form: choosing a date-time
   crate for every adopter is not the generator's call. `wire.nullMembers` is honored (ADR-0019
   Amendment 2); a request body always leaves an unset member out.
9. **`<Name>Create`, `<Name>Patch` and `validate()`.** A create body has no generated key and no
   read-only or derived member; a patch body makes every member optional and tells "set to null"
   from "leave alone". `validate()` returns every rule the value breaks and is held to the shared
   `validation-conformance` corpus. Rules across members run on a create body only, because a
   patch does not carry the members they compare. `validator.regex` is matched by a small matcher
   the support crate carries (the repository forbids a regex dependency), and a pattern outside
   what it supports is refused at generation, never at run time. The matcher keeps its choice
   points on the heap, so the call stack does not grow with the text. A match that spends its step
   budget (which grows with the text) is a give-up, reported by `validate()` as its own violation,
   never as a mismatch and never as a match.

**`client` and `commands`.**

10. **`client` is derived from the REST contract, not from a server.** Every port's route
    generators serve the same routes for the same model (FR-008, FR-009), so the client needs no
    Rust server to exist. A filter or a sort the server would refuse does not compile: the query
    type has one method per `@filterable` field and operator and an enum of the `@sortable`
    fields. `get`, `update` and `delete` exist only for a single key of text or a whole number; a
    view-backed entity is read-only. The transport is `reqwest` with its default features plus
    `json` and `query`.
    Clients for `object.projection` and `object.report` routes are not generated yet.
11. **`commands` writes a library, not a binary.** A `<package>_cli` crate exports a `clap`
    `Subcommand` and an asynchronous `run`; the binary, its name, the API's address and how an
    answer is printed are the application's. A body is `--json` overlaid by one flag per scalar
    member, read as the model's create or patch type, and held to `validate()` before anything is
    sent. A member the model does not declare is refused on the client side, where the mistake
    was made, not dropped.

**Gates.**

12. **The generated code is built, formatted and driven, not just compared.** The compile gate
    generates the small two-package model and the public fitness model with every shipped
    generator, runs `cargo check` and `rustfmt --check` on the result, and drives the generated
    client and commands over HTTP against a local server that records each request. Its scratch
    workspace resolves from a committed lockfile, and the gate fails when cargo needed a package
    the lockfile does not name, so a dependency never arrives unreviewed.
13. **The scale gate budgets structure, not seconds.** Twenty copies of the fitness model must
    write exactly twenty times one copy's files and no more than twenty times its bytes, one
    copy's output has a byte budget and a longest-file budget, and all the crates must build. A
    time budget on a shared machine measures the machine; the times are printed, and their
    ceilings sit far above a normal run to catch a step that stopped scaling.
