# ADR-0065: Rust is the sixth port

## Status

**Proposed** (2026-11-14). Registers no vocabulary: `metamodelVersion` is unchanged. Adds a sixth
language port under `server/rust/`, in preview, and a `rust` CI lane. Amends nothing.

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
   (`rust-toolchain.toml`). The first crate is `metaobjects` (node model, registry, providers,
   loader, serializer). `metaobjects-codegen` and `metaobjects-cli` join the workspace when they
   have code; the workspace carries no empty placeholder crates.

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
   that behavior yet. When the preview label comes off, an unlisted failure fails the lane.

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
   fitness model (`cargo run --release --example load_bench`) is kept beside the crate.

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
  `cargo fmt --check`, clippy with warnings denied and the crate's tests, and `pr-ci` and
  `local-ci` run it as their own job.
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
