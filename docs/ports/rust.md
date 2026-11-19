# Rust port (preview)

The Rust port is **in preview** ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)).
It reads a project, validates it and serializes it, and it is held to the same shared conformance
corpora as the other five ports. It does not generate code yet, and **nothing is published**: there
is no crate on crates.io, so there is nothing to `cargo add`. You work from a checkout of this
repository.

This page says what runs today, what does not exist yet, and how to build and test it. For the
decisions behind the port (why Rust, the layout, the preview rules), read the ADR.

## What works today

One crate, `metaobjects`, in the Cargo workspace at `server/rust/`:

| Area | What it does |
|---|---|
| Loading | Reads canonical JSON and sigil-free authoring YAML ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)): packages, children, subtypes, attributes, `extends` and references, with a line and column on every error from a YAML file. |
| Project resolution | Reads `.metaobjects/config.json` and resolves sources the way every port does: the four source kinds, directory discovery (symlinks followed, `_pending` skipped), and the `iam` and `ai` library sources, which are embedded in the crate so a library resolves with no file on disk. See [Metadata sources](../features/metadata-sources.md). |
| Naming | The naming strategies, the pluralizers and the collection-name collision check ([ADR-0058](../../spec/decisions/ADR-0058-one-physical-naming-setting.md)). |
| Registry | The type registry and the built-in providers. It is strict and sealed after bootstrap, with the same `ERR_*` codes as the other ports. |
| Validation | All 40 validation passes the TypeScript loader runs, in the same order. The ordered list is `PASSES` in `server/rust/metaobjects/src/validate/mod.rs`. |
| Serializer | The canonical serializer. A tree it loads serializes to the same bytes the other ports write. |
| Frozen tree | The loader freezes the tree when it finishes. A frozen tree memoizes its resolved reads (effective children, attributes and array-ness), so many readers can share one. |
| Timings | Every load records how long each phase and each validation pass took (`LoadResult::timings`). |

### Conformance

The port runs five shared corpora. A fixture that fails and is not on the port's ledger prints a
warning and does not fail the `rust` lane while the port is in preview; a fixture that passed and
regresses still fails it, because each ledger records how many fixtures must pass (`minPassing`) and
may only shrink.

| Corpus | Rust today |
|---|---|
| `registry-conformance` | byte-identical manifest |
| `conformance` (the metamodel corpus) | **526 of 526**, and the ledger is empty |
| `yaml-conformance` | 18 of 19. The one on the ledger, `yaml-ref-root-escape`, waits for the root-level `::` reference rules of [ADR-0059](../../spec/decisions/ADR-0059-references-resolve-once-after-the-tree.md), which are reference resolution, not a validation pass. |
| `source-resolution-conformance` | all 28 cases |
| `naming-conformance` | all of it |

Rust is not yet a column in the [per-corpus table](../CONFORMANCE.md#per-corpus-totals); it joins
when the port leaves preview. The other corpora (render, persistence, API contract, codegen compile)
need code the port does not have yet.

### Load benchmark

`load_bench` times loading a 20-times model built in memory from the public conformance fitness model
(`fixtures/persistence-conformance/canonical/meta.fitness.json`). It prints the median time of each
load phase and each of the 40 validation passes, and the peak memory of the process.

```bash
cd server/rust
cargo run --release --example load_bench                       # 20 copies, 15 iterations, JSON
cargo run --release --example load_bench -- 20 15 yaml         # the same model as YAML
cargo run --release --example load_bench -- 20 15 project      # the project-reading steps
cargo run --release --example load_bench -- --dir <project> --json   # a real project, one JSON line
```

`--write-baseline <file>` records a run and `--baseline <file>` compares against one. A baseline is a
record to read, never a threshold: the committed `baselines/load-20x.json` was recorded on one machine,
and a delta between two machines measures the machine. Compare against a baseline you recorded
yourself, before and after a change, on the same machine.

[`scripts/bench-load/`](../../scripts/bench-load/README.md) runs this same model through every port,
stage by stage (load and validate, a no-change generation run, a full generation, a one-entity-edit
regeneration, peak memory), so a port's speed can be tracked per feature next to the others.

## What does not exist yet

- **Code generation.** There is no Rust generator, no `meta gen` equivalent and no `eject`. The port
  loads and checks metadata; it does not write code.
- **The `cargo meta` command.** It is planned, not built. ADR-0065 names it: a Cargo subcommand (a
  `cargo-meta` binary), the way the other build-tool-hosted ports spell theirs (`dotnet meta`,
  `mvn metaobjects:...`). A bare `meta` stays the Node schema CLI.
- **Drift checks.** There is no `verify` for Rust yet, so nothing compares generated Rust to the model.
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
cargo test --locked                        # the corpora and the unit tests, about a second once built
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
```

The repository's one pre-PR script runs the same steps, plus the `load_bench` table (printed, never
gated on a number):

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

[`examples/tasks-axi-rust/`](../../examples/tasks-axi-rust/README.md) is the nearest thing to a Rust
code generator today, and it is an experiment, not a product. It reimplements the read path of an
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
