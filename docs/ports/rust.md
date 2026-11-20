# Rust port (preview)

The Rust port is **in preview** ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)).
It reads a project, validates it, serializes it and generates code from it, and it is held to the
same shared conformance corpora as the other five ports. Its command, `cargo meta`, runs the whole
codegen loop on a JSON or YAML model: `init`, `gen`, `verify --codegen` and `eject`. Three generators
ship: `entity`, `client` and `commands`. **Nothing is published**: there is no crate on crates.io, so
there is nothing to `cargo add` or `cargo install` from a registry. You work from a checkout of this
repository.

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
| Code generation (`cargo meta`) | The run engine, three generators (`entity`, `client`, `commands`), the codegen drift gate and `eject`. See [The command](#the-command-cargo-meta) and [What `gen` writes](#what-gen-writes) below. |

## The command: `cargo meta`

`cargo meta` is a Cargo subcommand (a `cargo-meta` binary), the way the other build-tool-hosted ports
spell theirs (`dotnet meta`, `mvn metaobjects:...`). A bare `meta` stays the Node schema CLI. Install it
from the checkout:

```bash
cargo install --path <repo-root>/server/rust/metaobjects-cli
```

| Command | What it does |
|---|---|
| `cargo meta init [--project <dir>]` | Scaffolds `.metaobjects/config.json`, `.metaobjects/.gitignore` (which keeps `.gen-state/.hashes.json` committed) and a first `metaobjects/meta.app.yaml`. It writes only what is missing, and never adds an empty metadata file to a project that already has metadata. |
| `cargo meta gen [ENTITY...]` | Generates the crates. It skips the whole run when the model, the project config and the generators are unchanged ([ADR-0064](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md)), writes only files whose bytes changed, removes a generated file nothing emits any more, and refuses to overwrite or delete a generated file that was edited by hand. It prints what it created, updated and removed, and the crates to re-check. |
| `cargo meta verify [--codegen] [--full]` | The codegen drift gate: renders in memory, compares with disk, writes nothing, and exits 1 on drift, naming each file. Locally it may answer from the stored skip key; `--full`, or a set `CI` variable, always renders. `--codegen` is the only gate the port ships, so a bare `verify` runs it. `--db`, `--templates` and `--deps` exit 2 with the reason and where that check lives. |
| `cargo meta eject <generator>...` | Copies a shipped generator into the project to own. `--undo` takes back copies still identical to the shipped source; `--list` shows what can be ejected and how each owned copy compares. See [Owning a generator](#owning-a-generator). |

`gen` and `verify` share `--project <dir>`, `--out <dir>` (default `generated`), `--generators <a,b>`,
`--strict` and `--timings`. `gen` adds `--force` and `--list`. `cargo meta --help` is the reference.

**Exit codes** are the ones every port's tool uses: 0 success, 1 the run failed (a model that does not
load, a refused file, drift), 2 a usage error. An unknown flag names the flags the command takes.
An owned generator crate that fails to build, or a generator in it that panics, is a failed run: 1,
with the compiler's or the panic's own message.

There is no `migrate`, no `verify --db` and no `fmt` in `cargo meta`. Schema migrations and database
checks are the Node `meta` tool's for every server language
([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)); a Rust project runs
`meta migrate` beside `cargo meta gen`, as a Java, C# or Python project does.

## What `gen` writes

One crate per metadata package ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)),
per generator, plus one shared crate per generator. For a package `shop`:

```text
generated/
  shop/           entity     the model: structs, enums, create and patch bodies, validate()
  shop_client/    client     a typed HTTP client and list query per served entity
  shop_cli/       commands   clap commands over the client
  meta_support/   entity     exact decimals, durations, patch helpers, the validation checks
  meta_client/    client     the HTTP transport (reqwest), errors, the query builder
  meta_cli/       commands   what a command uses to build a body and a query
```

The generated crates depend on each other by path and on ordinary crates.io crates (`serde`,
`serde_json`, `reqwest`, `clap`). **They import nothing from MetaObjects**: the shared code is written
into the three `meta_*` crates as source you can read and change. Add the crates you want to your
workspace as path dependencies:

```toml
[dependencies]
shop = { path = "generated/shop" }
shop_client = { path = "generated/shop_client" }
meta_client = { path = "generated/meta_client" }
```

Every file is written already formatted, and each crate carries the `rustfmt.toml` it was written
under, so `cargo fmt` over the output changes nothing.

### `entity`: the model crate

| In the model | In Rust |
|---|---|
| a concrete `object.entity` or `object.value` | a `pub struct` with every effective field (inherited ones included), `serde` derives |
| an entity | also `<Name>Create` (what a caller sends: no generated key, no read-only or derived member) and `<Name>Patch` (every member optional; a nullable member tells "set to null" from "leave alone") |
| a `field.enum` | a `pub enum` that serializes as the member symbols |
| a field that is not `@required` | `Option<T>`; an array is `Vec<T>`; a `field.map` is `BTreeMap<String, V>` |
| `field.object` | the struct its `@objectRef` names, `Box`ed when it closes a cycle; a reference into another package is a path dependency on that package's crate |
| `field.decimal` | `meta_support::wire::Decimal`, which holds the value as exact decimal text. It writes the portable decimal string and reads a string or a JSON number (a string stays exact; a fractional JSON number arrives as a float). Rust has no standard decimal type, so `wire.decimals` has nothing native to select |
| `field.duration` | `meta_support::wire::Duration`, signed ISO-8601 |
| `field.currency` | `i64` minor units |
| `field.inet` | `std::net::IpAddr` (text when the field is `@lenient`) |
| `date`, `time`, `timestamp`, `uuid`, `uri` | `String`, as on the wire; `validate()` checks the form |

A value object, a create body and a patch body each have `validate()`, which returns every rule of the
model the value breaks: lengths, bounds, item counts, patterns, text forms, the rules of a nested value
object and, on a create body, the model's rules across members (`validator.comparison`,
`requiredWhen`, `presentIff`, `atLeastOne`, `exactlyOne`). A `validator.regex` pattern is matched by a
small matcher the support crate carries, so no regex crate is needed; a pattern outside what that
matcher supports is refused when you generate, not at run time. The matcher keeps its choice points on
the heap, so a text of any length matches a repeated group such as `^(\w+\s?)*$` without overflowing
the stack. Each match has a step budget that grows with the text, and a pathological pattern that
spends it reports its own violation, `'field' pattern could not be evaluated within limits`, never
the ordinary mismatch.

The project's `wire.nullMembers` setting is honored: `omit` leaves a `None` member out of the JSON,
and the default writes `null`, which is what `serde` does on its own
([ADR-0019 Amendment 2](../../spec/decisions/ADR-0019-runtime-return-type-contract.md)). Request bodies
(`<Name>Create`, `<Name>Patch`) always leave an unset member out.

Navigation across relationships is not generated: a relationship is not a field, and the foreign-key
fields it is built on are.

### `client`: a typed client for the REST API the model implies

Every port's server generators serve the same routes for the same model
([the API contract](../features/api-contract.md)), so a client for them is derivable from the model
alone. For each served entity (concrete, backed by a `source.rdb`):

```rust
let api = meta_client::Client::new("https://example.test/api");
let orders = shop_client::OrderClient::new(&api);

let query = shop_client::OrderQuery::new()
    .status_eq(shop::OrderStatus::InFlight)
    .total_gte(1250)
    .sort(shop_client::OrderSort::Total, meta_client::Direction::Descending)
    .limit(20);
let rows: Vec<shop::Order> = orders.list(&query).await?;
let page = orders.page(&query).await?;          // rows and the total the filters match
let one = orders.get(7).await?;
```

- `<Name>Query` has one method per field and operator the model's `@filterable` allows, taking a value
  of the field's own type, and `sort` takes an enum of the `@sortable` fields. A request the server
  would refuse for its filter or its sort does not compile. `raw` is the escape hatch.
- `get`, `update` and `delete` exist when the entity has a single key of text or a whole number. An
  entity with a composite key is listed and created only.
- A view-backed entity gets reads only. A subtype of a single-table hierarchy is reached under its
  base, at its discriminator value (`auths/bridge`). A many-to-many relationship gets
  `<relation>_of(id)`.
- An error is `meta_client::Error`: `Transport`, `Api` (the status and the contract's
  `{error, message}` body) or `Decode`.

The transport is `reqwest` with its default features, written out as the `meta_client` crate. A project
that wants another HTTP stack or TLS backend changes that one crate, which it owns.

Not generated yet: clients for `object.projection` and `object.report` routes.

### `commands`: command-line commands over the client

For each served entity the generator writes a `clap` command group: `list`, `get`, `create`, `update`,
`delete` and one command per many-to-many relationship. A `<package>_cli` crate exports a
`clap::Subcommand` and an asynchronous `run`, and no `main`: the binary, its name, where the API's
address comes from and how an answer is printed are your application's.

```rust
#[derive(clap::Parser)]
struct App {
    #[command(subcommand)]
    command: shop_cli::Command,
}

let app = <App as clap::Parser>::parse();
let api = meta_client::Client::new(&std::env::var("SHOP_API")?);
let answer = shop_cli::run(app.command, &api).await?;   // a serde_json::Value to print
```

```bash
app order list --filter status=IN_FLIGHT --filter total:gte=1250 --sort total:desc --limit 20 --count
app order create --json "$(cat order.json)" --total 1250
app order update 7 --status done --total 1500
```

`list` checks `--filter` and `--sort` against the same allowlists the typed client is built from.
`create` and `update` take the body as `--json` (or `-` for standard input) and one flag per scalar
member, a flag winning over the body. The finished body is read as the model's create or patch type
and held to its `validate()` before anything is sent, and a member the model does not declare is
refused, not dropped.

**`commands` is Rust-only, by decision** (ADR-0065 Amendment 1). No other port ships it. The shared
[generator registry](../../fixtures/generator-registry-conformance/README.md) records `client` and
`commands` with `rust` as their only port, so the difference is stated in the one place every port
checks itself against, not left to be discovered.

### Owning a generator

A generator is a reference helper
([ADR-0034](../../spec/decisions/ADR-0034-codegen-scaffold-and-own.md)): copy it and change the
copy. Rust is compiled, so an owned generator cannot be loaded from source at run time. `eject`
therefore writes a small crate the project owns:

```text
codegen/
  Cargo.toml             depends on the engine; written once, then yours
  main.rs                the generator list; written once, then yours
  generators/<name>.rs   one owned copy per ejected generator
```

While that crate exists, `cargo meta gen` and `cargo meta verify` build and run it, so there is still
one way to generate. A copy is the shipped source byte for byte, and it imports only the engine
surface (`metaobjects_codegen::{emitted, generator, names, plan, writer}`); the shared text a generator
writes (the transport, the command helpers) is inside the generator, so an owned `client` owns its
transport too. Every file in `codegen/` is an input of the skip key, whether `eject` wrote it or you
added it (a module beside the generator list, say), so editing any of them regenerates. Only the
crate's build directory (`codegen/target`) and its `Cargo.lock` are left out.

`cargo meta gen --list` shows each owned copy as `identical`, or as `DIFFERS` with how many shipped
lines it lacks and how many are its own.
`cargo meta eject --undo` removes copies that are still identical (`--force` discards an edited one)
and tells you the two lines of `codegen/main.rs` to change; it never edits that file.

This is **not a plugin contract**. Nothing discovers or loads a third-party generator, and the
engine's Rust API carries no stability promise while the port is in preview: an owned copy is pinned
to the engine checkout its `Cargo.toml` points at.

### Conformance

The port runs the shared corpora below. Four of them keep a ledger: a fixture that fails and is not on
the port's ledger prints a warning and does not fail the `rust` lane while the port is in preview; a
fixture that passed and regresses still fails it, because each ledger records how many fixtures must
pass (`minPassing`) and may only shrink. The others have no ledger: each case asserts its result
outright.

| Corpus | Rust today |
|---|---|
| `registry-conformance` | byte-identical manifest |
| `conformance` (the metamodel corpus) | **574 of 574**, and the ledger is empty |
| `yaml-conformance` | 18 of 19. The one on the ledger, `yaml-ref-root-escape`, waits for the root-level `::` reference rules of [ADR-0059](../../spec/decisions/ADR-0059-references-resolve-once-after-the-tree.md), which are reference resolution, not a validation pass. |
| `source-resolution-conformance` | all 28 cases |
| `naming-conformance` | all of it |
| `codegen-skip-conformance` | every case the port can meet, on both columns (what `gen` must do and what a local `verify --codegen` may do), including an edited owned generator and a forced CI verify ([ADR-0064](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md)). The three it cannot meet (two about templates, one about the three-way merge) are named with their reason in the runner. |
| `validation-conformance` | every case, through the generated `validate()`: each payload is read into the generated create body by a probe the real compiler builds |
| `decimal-wire`, `duration-wire` | every vector, against the code the support crate carries |
| `writer-conformance` | every `core` case of the code writer ([ADR-0063](../../spec/decisions/ADR-0063-generators-own-layout.md)) |
| `generator-registry-conformance` | the shipped generators are exactly the registry's `rust` entries, with its tier and layer, and the eject contract's census, completeness and depth hold (ADR-0034 Amendment 8) |

Two gates have no corpus of their own:

- **The codegen-compile gate.** The small two-package model and the public fitness model are generated
  by every shipped generator, each into a scratch Cargo workspace that `cargo check` builds and
  `rustfmt --check` reads file by file. A probe then uses the generated types and drives the generated
  client and commands over HTTP against a local server that records each request. The workspace
  resolves from a committed lockfile (`metaobjects-codegen/tests/gen-check.lock`), and the gate fails
  when cargo needed a package that lockfile does not name.
- **The scale gate.** Twenty copies of the fitness model, each its own package: the output must be
  exactly twenty times one copy's files and no more than twenty times its bytes, one copy's output has
  a byte budget and a longest-file budget, and all sixty-three crates must build. The times are
  printed; their ceilings are set far above a normal run and catch a step that stopped scaling, not
  a slow machine.

Rust is not yet a column in the [per-corpus table](../CONFORMANCE.md#per-corpus-totals); it joins
when the port leaves preview. The other corpora (render, persistence, API contract) need code the
port does not have yet.

### Load benchmark

`load_bench` (a Cargo example) times loading a 20-times model built in memory from the public
conformance fitness model, per load phase and per validation pass, with the peak memory of the
process. Its invocations, the baseline options and the committed baseline are documented in
[`scripts/bench-load/README.md`](../../scripts/bench-load/README.md#rust-load_bench).

[`scripts/bench-load/`](../../scripts/bench-load/README.md) runs this same model through every port,
stage by stage (load and validate, a no-change generation run, a full generation, a one-entity-edit
regeneration, peak memory), so a port's speed can be tracked per feature next to the others.

## What does not exist yet

- **Other generators.** There is no server-side route, ORM or repository generator, no template
  generator and no documentation generator. Projections and reports get no client yet.
- **Other gates.** `verify --codegen` is the only one. There is no template gate, no requirement gate
  and no `fmt`. That includes the business-rules checks `verify` runs in the other ports (an unreachable state, a
  permission name left to derive): the loader refuses a broken operation or lifecycle, and the port reads
  and validates the `rules` and `verify.lifecycle` settings, but nothing reports on them.
- **A three-way merge.** A hand-edited generated file is refused by name, as in every port but
  TypeScript; change the model or own the generator instead.
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
cargo test --locked                        # the corpora, the unit tests and the codegen gates (these run cargo check on generated crates)
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
```

The codegen gates build generated crates under `server/rust/target/gen-check/` and write their scratch
projects under `$DEV_SCRATCH` (the system temp directory when it is unset), removing them afterwards.
The first run downloads and builds `reqwest`, `tokio` and `clap` once. When the generated crates'
dependencies change, refresh the gate's lockfile deliberately:
`UPDATE_GEN_LOCK=1 cargo test -p metaobjects-codegen --test compile generated_crates`.

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
and it is not the port's generator (that is `cargo meta gen`, above; it predates the `commands` generator). It reimplements the read path of an
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
