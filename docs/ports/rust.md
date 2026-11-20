# Rust port (preview)

The Rust port is **in preview** ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)).
It reads a project, validates it, serializes it and generates code from it, and it is held to the
same shared conformance corpora as the other five ports. Code generation covers the `entity`
generator only. **Nothing is published**: there is no crate on crates.io, so there is nothing to
`cargo add`. You work from a checkout of this repository.

This page says what runs today, what does not exist yet, and how to build and test it. For the
decisions behind the port (why Rust, the layout, the preview rules), read the ADR.

## What works today

The loader is the `metaobjects` crate, and the workspace at `server/rust/` adds the codegen crate
(`metaobjects-codegen`, the run engine and generator) and the CLI crate (`metaobjects-cli`, the
`cargo-meta` binary). What each area does:

| Area | What it does |
|---|---|
| Loading | Reads canonical JSON and sigil-free authoring YAML ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)): packages, children, subtypes, attributes, `extends` and references, with a line and column on every error from a YAML file. |
| Project resolution | Reads `.metaobjects/config.json` and resolves sources the way every port does: the four source kinds, directory discovery (symlinks followed, `_pending` skipped), and the `iam` and `ai` library sources, which are embedded in the crate so a library resolves with no file on disk. See [Metadata sources](../features/metadata-sources.md). |
| Naming | The naming strategies, the pluralizers and the collection-name collision check ([ADR-0058](../../spec/decisions/ADR-0058-one-physical-naming-setting.md)). |
| Registry | The type registry and the built-in providers. It is strict and sealed after bootstrap, with the same `ERR_*` codes as the other ports. |
| Validation | All 41 validation passes the TypeScript loader runs, in the same order, the business-rules pass among them (operations, permission names and lifecycles, [ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md)). The ordered list is `PASSES` in `server/rust/metaobjects/src/validate/mod.rs`. |
| Serializer | The canonical serializer. A tree it loads serializes to the same bytes the other ports write. |
| Frozen tree | The loader freezes the tree when it finishes. A frozen tree memoizes its resolved reads (effective children, attributes and array-ness), so many readers can share one. |
| Timings | Every load records how long each phase and each validation pass took (`LoadResult::timings`). |
| Code generation (`cargo meta gen`) | The run engine and the `entity` generator, one crate per metadata package. The command and its flags are in the [CLI reference](../features/cli.md). |

### Conformance

The port runs six shared corpora. Four of them keep a ledger: a fixture that fails and is not on the
port's ledger prints a warning and does not fail the `rust` lane while the port is in preview; a
fixture that passed and regresses still fails it, because each ledger records how many fixtures must
pass (`minPassing`) and may only shrink. `registry-conformance` (a byte-for-byte manifest) and
`codegen-skip-conformance` (each case asserts its result outright) have no ledger.

| Corpus | Rust today |
|---|---|
| `registry-conformance` | byte-identical manifest |
| `conformance` (the metamodel corpus) | **574 of 574**, and the ledger is empty |
| `yaml-conformance` | 18 of 19. The one on the ledger, `yaml-ref-root-escape`, waits for the root-level `::` reference rules of [ADR-0059](../../spec/decisions/ADR-0059-references-resolve-once-after-the-tree.md), which are reference resolution, not a validation pass. |
| `source-resolution-conformance` | all 28 cases |
| `naming-conformance` | all of it |
| `codegen-skip-conformance` | the cases its `gen` can meet (ADR-0064); the rest are named with their reason in the runner |

Rust is not yet a column in the [per-corpus table](../CONFORMANCE.md#per-corpus-totals); it joins
when the port leaves preview. The other corpora (render, persistence, API contract, codegen compile)
need code the port does not have yet.

### Load benchmark

`load_bench` (a Cargo example) times loading a 20-times model built in memory from the public
conformance fitness model, per load phase and per validation pass, with the peak memory of the
process. Its invocations, the baseline options and the committed baseline are documented in
[`scripts/bench-load/README.md`](../../scripts/bench-load/README.md#rust-load_bench).

[`scripts/bench-load/`](../../scripts/bench-load/README.md) runs this same model through every port,
stage by stage (load and validate, a no-change generation run, a full generation, a one-entity-edit
regeneration, peak memory), so a port's speed can be tracked per feature next to the others.

## What does not exist yet

- **Other generators.** Only `entity` exists. There is no template, client, API or ORM generator. Relationships,
  projections and reports are not emitted.
- **Other `cargo meta` commands.** Only `gen` exists: no `init`, `eject`, `verify` or `fmt`. The command is a
  Cargo subcommand (a `cargo-meta` binary), the way the other build-tool-hosted ports spell theirs (`dotnet meta`,
  `mvn metaobjects:...`). A bare `meta` stays the Node schema CLI.
- **Drift checks.** There is no `verify` for Rust yet, so nothing compares generated Rust to the model. That includes the business-rules checks `verify` runs in the other ports (an unreachable state, a permission name left to derive): the loader refuses a broken operation or lifecycle, and the port reads and validates the `rules` and `verify.lifecycle` settings, but nothing reports on them.
- **The service tier.** No `ObjectManager`, no persistence drivers and no web adapters.
- **Templates and prompts.** No render engine, no payload value objects and no output parser.
- **Publication.** The crate sets `publish = false`. There is no crates.io release, no version policy
  beyond ADR-0065 (the port starts on its own `0.x` line when it publishes, and joins the lockstep
  numbers only when it leaves preview), and `Cargo.toml` is not a stable interface.

**A note on the name `cargo-meta`.** The crates.io name `cargo-meta` is held by an unrelated crate. The
plan is to publish the CLI crate under another name that installs a `cargo-meta` binary, so the command
you type is still `cargo meta`. That is a plan, not a promise: the crate name is not chosen, and
nothing is reserved.

The schema stays where it is for every port: migrations and database checks run in the Node `meta`
tool ([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md);
[What differs by language](../features/language-differences.md)).

## Build and test

You need `rustup`. The workspace pins its toolchain in `server/rust/rust-toolchain.toml` (1.94.1, with
`rustfmt` and `clippy`), so `cargo` picks it up on its own.

```bash
cd server/rust
cargo build
cargo test --locked                        # the corpora, the unit tests and the codegen suites (these run cargo check on generated crates)
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
```

The repository's one pre-PR script runs the same steps, plus the `load_bench` and `gen_bench` tables
(printed, never gated on a number):

```bash
scripts/ci-local.sh --only rust
```

A change under `server/rust/` selects the `rust` lane in `scripts/ci-local.sh --affected`, the PR checks
and the local CI. Raise the pinned toolchain deliberately, in its own commit.

Use the crate from a checkout, as a path dependency:

```toml
[dependencies]
metaobjects = { path = "<repo-root>/server/rust/metaobjects" }
```

```rust
use metaobjects::collection::resolve_collection;
use metaobjects::loader::Loader;
use metaobjects::naming::NamingRegistry;
use metaobjects::providers::default_registry;

let registry = default_registry()?;
let collection = resolve_collection(project_dir, None, &NamingRegistry::builtin())?;
let (sources, read_errors) = collection.read_sources();
let result = Loader::new(&registry).load_sources(&sources);
assert!(read_errors.is_empty() && result.errors.is_empty());
```

The API is a preview and will change; read `server/rust/metaobjects/tests/project_load.rs` for a
working call.

## A worked codegen exercise: `examples/tasks-axi-rust/`

[`examples/tasks-axi-rust/`](../../examples/tasks-axi-rust/README.md) is an experiment, not a product,
and it is not the port's generator (that is `cargo meta gen`, above). It reimplements the read path of an
agent-facing task tracker as a small Rust binary and **generates the Rust for its rows, enums, error
codes, argument parser, help text and dispatcher from a MetaObjects model**, with an owned TypeScript
generator (ADR-0034). The real tool is the oracle: for every implemented command and flag the two print
the same bytes and exit with the same code.

It changes nothing in MetaObjects. Its committed generated crate is the set of golden outputs a
Rust-native generator would have to reproduce, and its README records what the model had to carry. Read
its README, not this page, for what it does and does not do.

## See also

- [ADR-0065: Rust is the sixth port](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)
- [Conformance coverage](../CONFORMANCE.md): the corpora, and Rust's standing in them.
- [What differs by language](../features/language-differences.md)
- The other port pages: [TypeScript](typescript.md), [C#](csharp.md), [Java](java.md),
  [Kotlin](kotlin.md), [Python](python.md).
