# Rust port

The Rust port is a full language of 1.3.0 ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)).
It reads a project, validates it, serializes it and generates code from it, and it is held to the
same shared conformance corpora as the other five ports. Its command, `cargo meta`, runs the whole
codegen loop on a JSON or YAML model: `init`, `gen`, `verify --codegen`, `verify --templates` and `eject`. Three generators
ship: `entity`, `client` and `commands`, and a project chooses which of them run in
`metaobjects.config.json`. The four crates are **ready to publish but not published**: they package and
build from their packages (a `cargo publish --dry-run` runs in the `rust` lane), and there is no release
on crates.io yet, so there is nothing to `cargo add` or `cargo install` from a registry. You work from a
checkout of this repository until the first release.

This page says what runs today, what does not exist yet, and how to build and test it. For the
decisions behind the port (why Rust, the layout, the conformance rules), read the ADR.

## What works today

The loader is the `metaobjects` crate, and the workspace at `server/rust/` adds the codegen crate
(`metaobjects-codegen`, the run engine and generator), the CLI crate (`metaobjects-cli`, the
`cargo-meta` binary) and the prompt crate (`metaobjects-render`, render and the reply parser). What each area does:

| Area | What it does |
|---|---|
| Loading | Reads canonical JSON and sigil-free authoring YAML ([ADR-0006](../../spec/decisions/ADR-0006-ai-first-yaml-authoring.md)): packages, children, subtypes, attributes, `extends` and references, with a line and column on every error from a YAML file. |
| Project resolution | Reads `.metaobjects/config.json` and resolves sources the way every port does: the four source kinds, directory discovery (symlinks followed, `_pending` skipped), and the `iam` and `ai` library sources, which are embedded in the crate so a library resolves with no file on disk. See [Metadata sources](../features/metadata-sources.md). |
| Naming | The naming strategies, the pluralizers and the collection-name collision check ([ADR-0058](../../spec/decisions/ADR-0058-one-physical-naming-setting.md)). |
| Registry | The type registry and the built-in providers. It is strict and sealed after bootstrap, with the same `ERR_*` codes as the other ports. |
| Validation | All 41 validation passes the TypeScript loader runs, in the same order, the business-rules pass among them (operations, permission names and lifecycles, [ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md)). The ordered list is `PASSES` in `server/rust/metaobjects/src/validate/mod.rs`. |
| Serializer | The canonical serializer. A tree it loads serializes to the same bytes the other ports write. |
| Prompt rendering | `metaobjects_render::render` renders a `template.*` body over a JSON payload as every port does: partials expanded ahead of time, each `{{value}}` escaped for the template's format (`text`, `markdown`, `html`, `xml`, `csv`, `spreadsheet`, `json`), derived `has<Field>` and `-last` accessors, and a fail-closed `maxChars` budget. The Mustache engine underneath is the `mustache-ng` crate. |
| Reply parser | `metaobjects_render::extract::extract` reads a typed answer out of a model's reply (FR-010, FR-011): fences, prose, comments, trailing commas and cut-off values tolerated, every declared field classified (`EXTRACTED`, `DEFAULTED`, `LOST_OPTIONAL`, `LOST_REQUIRED`, `MALFORMED`) and coerced to its kind, under a `STRICT`, `NORMAL` or `LOOSE` tolerance. `metaobjects_render::prompt::render_output_format` writes the output-format fragment that asks for that answer, in the `guide`, `inline` and `exampleOnly` styles. |
| Frozen tree | The loader freezes the tree when it finishes. A frozen tree memoizes its resolved reads (effective children, attributes and array-ness), so many readers can share one. |
| Timings | Every load records how long each phase and each validation pass took (`LoadResult::timings`). |
| Report shapes | `metaobjects::report_shape::report_shape` derives an `object.report`'s fields (FR-044 Table B, with Table C's `required`): each dimension and measure, its subtype, and the `@of` field it takes its type from. It byte-matches `fixtures/persistence-conformance/report-shapes.json`, as every port does. |
| Code generation (`cargo meta`) | The run engine, ten generators (`entity`, `rules-names`, `contract-types`, `repository`, `service`, `client`, `commands`, `render-helper`, `output-parser`, `output-prompt`), the codegen and template drift gates and `eject`. See [The command](#the-command-cargo-meta) and [What `gen` writes](#what-gen-writes) below. |

## The command: `cargo meta`

`cargo meta` is a Cargo subcommand (a `cargo-meta` binary), the way the other build-tool-hosted ports
spell theirs (`dotnet meta`, `mvn metaobjects:...`). A bare `meta` stays the Node schema CLI. Install it
from the checkout:

```bash
cargo install --path <repo-root>/server/rust/metaobjects-cli
```

To use a candidate or any other commit without a checkout, pin it from git
(`cargo install --git https://github.com/metaobjectsdev/metaobjects --rev <commit> metaobjects-cli`,
and the same `git` + `rev` on a `metaobjects` dependency). The candidate log
(`tools/prerelease/candidates.md`) names the commit each staged candidate was built from; see
[Pre-releases, "Rust"](../features/prerelease.md#rust).

| Command | What it does |
|---|---|
| `cargo meta init [--project <dir>]` | Scaffolds `.metaobjects/config.json`, `.metaobjects/.gitignore` (which keeps `.gen-state/.hashes/` committed), a first `metaobjects/meta.app.yaml` and `metaobjects.config.json`, the list of generators to run (see [Choosing generators](#choosing-generators)). It writes only what is missing, and never adds an empty metadata file to a project that already has metadata. |
| `cargo meta gen [ENTITY...]` | Generates the crates. It skips the whole run when the model, the project config and the generators are unchanged ([ADR-0064](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md)), writes only files whose bytes changed, removes a generated file nothing emits any more, and refuses to overwrite or delete a generated file that was edited by hand. It prints what it created, updated and removed, and the crates to re-check. |
| `cargo meta verify [--codegen] [--templates] [--full]` | The codegen drift gate: renders in memory, compares with disk, writes nothing, and exits 1 on drift, naming each file. Locally it may answer from the stored skip key; `--full`, or a set `CI` variable, always renders. `--codegen` runs that gate alone. `--templates` is the template drift gate: each `template.*` body (under `prompts/`, or `--prompts <dir>`) against its payload value object, and each prompt's `@responseRef` reply; a bare `verify` runs it too, and a Jinja body is refused (`ERR_TEMPLATE_ENGINE_UNSUPPORTED`). A bare `verify` also runs the business-rules gate ([ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md)) on the loaded model, and prints nothing about it when the model declares no operation and no transition; an error-severity finding (a `rules.permissions.names` of `require`, or `verify.lifecycle.unreachable` of `error`) exits 1. `--db` and `--deps` exit 2 with the reason and where that check lives. |
| `cargo meta eject <generator>...` | Copies a shipped generator into the project to own. An existing copy is refused; `--force` replaces it with the reference, and leaves a copy that already matches untouched. `--undo` takes back copies still identical to the shipped source; `--list` shows what can be ejected and how each owned copy compares. See [Owning a generator](#owning-a-generator). |

`gen` and `verify` share `--project <dir>`, `--out <dir>` (default `generated`), `--generators <a,b>`,
`--strict` and `--timings`. `gen` adds `--force` and `--list`. `cargo meta --help` is the reference.

### Choosing generators

The generators a project runs are the list in `metaobjects.config.json` at the project root, the way the
other ports choose theirs (`metaobjects.config.ts`, `codegen/Generators.cs`, the pom,
`metaobjects.config.yaml`). `cargo meta init` writes every shipped generator; delete a line to stop
running one, and no eject is needed:

```json
{ "generators": ["entity", "client", "commands", "render-helper", "output-parser", "output-prompt"] }
```

The file takes that one key: a layer is only a generator, so there are no layer settings. An entry is a
name, or `{"name": "<generator>", "options": {...}}` for a generator that takes options; the
generator's `configure` reads them and refuses a key it does not know (`ERR_UNKNOWN_GENERATOR_OPTION`,
naming the options it takes). The shipped generators take none, so any option given to one fails the
run, also a run `--generators` narrows to other generators. A project with no such file runs every
generator. A generator that leaves the list has its files removed
on the next `gen` (a file somebody edited is refused by name instead), and the run fails, naming the
file, for a name nothing offers, a duplicate, an unknown key, or a generator listed without one it
builds on (`client`, `render-helper` and `output-parser` need `entity`; `commands` needs `entity` and `client`). `cargo meta gen --list` shows each generator
as `[configured]` or `[not configured]`, and `--generators` narrows one run to some of the list.

**Exit codes** are the ones every port's tool uses: 0 success, 1 the run failed (a model that does not
load, a refused file, drift), 2 a usage error. An unknown flag names the flags the command takes.
An owned generator crate that fails to build, or a generator in it that panics, is a failed run: 1,
with the compiler's or the panic's own message.

There is no `migrate`, no `verify --db` and no `fmt` in `cargo meta`. Schema migrations run in your
own migration tool (sqlx migrations, say), handed the schema `meta schema` prints; the Node
`meta migrate` is the reference migration helper, one option, and the database check is the Node
`meta verify --db` ([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)).

## What `gen` writes

One crate per metadata package ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md)),
per generator, plus one shared crate per generator. For a package `shop`:

```text
generated/
  shop/           entity     the model: structs, enums, create and patch bodies, validate()
  shop_client/    client     a typed HTTP client and list query per served entity
  shop_cli/       commands   clap commands over the client
  shop_prompts/   render-helper   a typed render function per template (when the package has templates)
  shop_parsers/   output-parser   a strict parse and a tolerant extract per responding prompt
  shop_formats/   output-prompt   the output-format fragment per responding prompt
  shop_rules/     rules-names     lifecycles, commands, operations, permissions, business errors (when the package declares rules)
  shop_contract/  contract-types  each operation's input, output and errors (when the package declares operations)
  shop_store/     repository list, count, get, create, update, delete and the guarded update per stored entity, on sqlx
  shop_service/   service    each operation in one transaction, with the rules checks, over the store
  meta_support/   entity     exact decimals, durations, patch helpers, the validation checks
  meta_client/    client     the HTTP transport (reqwest), errors, the query builder
  meta_cli/       commands   what a command uses to build a body and a query
  meta_store/     repository the table descriptor, filters, and the Postgres and SQLite statements
  meta_service/   service    the error codes and statuses, the transaction and the guarded move
```

The generated crates depend on each other by path and on ordinary crates.io crates (`serde`,
`serde_json`, `reqwest`, `clap`). **The model, client and command crates import nothing from
MetaObjects**: the shared code is written into the three `meta_*` crates as source you can read and
change. The three prompt-tier crates import `metaobjects-render`, an ordinary Apache-2.0 library (the
render engine and the reply parser), as every port's prompt tier imports its render package. It is not
on crates.io yet, so until it is, point a `[patch.crates-io]` entry at a checkout's
`server/rust/metaobjects-render`. Add the crates you want to your
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
| a served read: a concrete `object.projection` or `object.report` whose read source is a view | a read-only `pub struct`, with no create or patch body. A report's members are its dimensions, then its measures, each typed as FR-044 Table B derives it (a dimension and a `min`/`max` as their `@of` field, a `count` as `i64`, a ratio as `Decimal`, a `sum` of an int as `i64`) and an `Option` unless Table C says the column is never null |
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

The transport is `reqwest` with its default features plus `json` and `query`, written out as the
`meta_client` crate. A project that wants another HTTP stack or TLS backend changes that one crate,
which it owns.

Not generated yet: clients (and commands) for `object.projection` and `object.report` routes. No Rust transport serves them yet, so they wait for it.

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

### `render-helper`: a render function per template

For each `template.output` and `template.prompt` the generator writes a typed function in a
`<package>_prompts` crate. A document template (the default `@kind`, and every prompt) gets
`render_<name>(&payload, &provider) -> Result<String, RenderError>`, escaped for its `@format` and held
to its `@maxChars`. An email template gets one returning an `EmailDocument`: the subject and the text
body rendered as text, the HTML body as HTML. The payload is the value object's own struct from the
`entity` crate ([ADR-0056](../../spec/decisions/ADR-0056-value-object-types-are-generated-once.md)).

```rust
use metaobjects_render::FilesystemProvider;

let provider = FilesystemProvider::new("prompts");
let text = shop_prompts::render_order_summary(&summary, &provider)?;
```

**The drift gate runs when you generate.** Each body is read from the project's template directory
(`prompts/` when it exists, else `templates/`) and checked against the payload's fields, nested value
objects included. A variable the payload does not have fails `cargo meta gen` with
`ERR_VAR_NOT_ON_PAYLOAD`, naming the template, the reference and the variable. The field tree is also
written into the function, and every render checks the body again, so a body edited after generation,
or served by another provider, fails the render instead of rendering a blank. A body is an input of
the generator: editing one regenerates the crate even when the model did not change.

### `output-parser` and `output-prompt`: the reply to a prompt

A `template.prompt` with `@responseRef` names the value object its answer is read into
([ADR-0052](../../spec/decisions/ADR-0052-template-direction-outbound-vs-inbound.md)). `output-parser` writes, in a
`<package>_parsers` crate:

- `parse_<name>(text) -> Result<T, serde_json::Error>`, the strict parse: the reply must be exactly
  the JSON of a `T`. A prompt whose `@responseFormat` is `xml` has none
  ([ADR-0053](../../spec/decisions/ADR-0053-inbound-response-format.md)).
- `extract_<name>(text, &opts) -> Extracted<T>`, the tolerant read of a raw model reply. It never
  fails: `value` is the answer when the extracted fields make a complete `T`, and `outcome.report`
  classifies every field either way.
- `<name>_schema()`, the extract descriptor both read with, derived from the response object as every
  port derives it: nested value objects, numeric ranges and element counts from the field's
  validators, `@enumAlias`, `@coerceDefault`, `@default`, `@normalize` and `@xmlText`.

`output-prompt` writes, in a `<package>_formats` crate, `render_<name>_format(&overrides) -> String`:
the part of the prompt that tells the model how to shape its answer, in the reply's syntax and the
prompt's `@promptStyle` (`guide`, `inline` or `exampleOnly`), with each field's `@example`,
`@instruction` and `@enumDoc`. Its root is the response object's name, the root the parser looks for.

```rust
let fragment = shop_formats::render_judge_format(&PromptOverrides::default());
let reply = call_the_model(&format!("{prompt}\n\n{fragment}"))?;
let got = shop_parsers::extract_judge(&reply, &ExtractOptions::default());
match got.value {
    Some(verdict) => use_it(verdict),
    None => log_the_report(&got.outcome.report),
}
```

### `rules-names` and `contract-types`: the rules layers

The business-rules vocabulary ([ADR-0066](../../spec/decisions/ADR-0066-business-rules-operations-and-lifecycles.md))
gets the first two layers of [ADR-0067](../../spec/decisions/ADR-0067-layering-and-the-service-seam.md).
Both write nothing for a package that declares no lifecycle and no operation, so turning them on
changes nothing for a model without rules.

`rules-names` (layer 0) writes a `<package>_rules` crate of names hand-written code can match on:

- a module per entity with a lifecycle, and in it a module per lifecycle field: `State` (the model
  crate's own enum, so a value read off a record compares directly), `FIELD`, `STATES`, `INITIAL`,
  `TERMINAL` and `Transition` (`name()`, `from()`, `to()`), plus `Command`, the commands derived
  from the transitions no operation claims, with the permission each asks about;
- `Operation` (`kind()`, `permission()`, `transitions()`, `errors()`), `Permission` (every
  permission the package asks about, declared or derived: `<package>.<operation>` and
  `<package>.<Entity>.<transition>`), `BusinessError` and `ShellError` (the five codes the
  enforcing shell answers with). Each is a closed enum with `ALL`.

`contract-types` (layer 1) writes a `<package>_contract` crate. Its `operations` module has, per
operation, `<Op>Input` and `<Op>Output` (the model's own types, a `Vec` for `@many`),
`<Op>BusinessError` (its declared `@errors`, or `NoBusinessError`) and `<Op>Error`, the error body
whose code is a fixed one or one of its own. A projection an operation returns gets its read shape
in that crate, unless it is view-backed: then it is the model crate's, and the operation names that. The shared `meta_contract` crate holds the wire error contract: `ErrorCode` with
each code's HTTP status, `ErrorBody`, `ValidationErrorBody` and `ConstraintViolationBody`. An
entity's read, create and patch shapes, with `validate()`, are the model crate's; it carries no
persistence mapping, so it already is the contract.

```rust
let body: DecideError = serde_json::from_slice(&response)?;
match body.error {
    OperationCode::Business(DecideBusinessError::OverBudget) => ask_for_less(),
    OperationCode::Fixed(code) => fail(code.status()),
    OperationCode::Business(DecideBusinessError::AlreadyDecided) => refresh(),
}
```

### `repository`: data access on sqlx

`repository` ([ADR-0067](../../spec/decisions/ADR-0067-layering-and-the-service-seam.md) layer 3)
writes a `<package>_store` crate with a module per entity that has a source, and per served read
(a view-backed projection or report). Each module has `TABLE`, the physical mapping (table, schema, key, and each field's column and storage
kind, under the project's `naming` strategies and every `@table`/`@column`), and typed functions
over it:

- `list(c, &Query)` (a `Filter` of the nine operators, sort and paging), `count(c, Option<&Filter>)`
  and `get(c, id)`, which a report (it has no key) does not get;
- `create(c, &XCreate)`, `update(c, id, &XPatch)` (`None` when there was no row) and
  `delete(c, id)` (`false` when there was none), for an entity whose source is writable. A
  projection and a report are read only;
- per lifecycle (ADR-0066), the guarded update `transition_<field>(c, id, from, to)`: one
  `UPDATE ... WHERE key = id AND state IN (from)`, `false` when no row matched because it is gone
  or another writer moved it first. It decides nothing: which move is legal, and who may make it,
  is the service's (layer 4). Underneath it is `meta_store::transition`, which also takes a
  transition's `@condition` (a `meta_store::Condition`, the CHECK subset: the six comparisons, the
  null tests, and, or, not and coalesce) and ANDs it into the same statement; a literal compared
  with a field is written in that field's stored form, so an int-backed enum's member is its integer.

`c` is a `sqlx::PgConnection` or a `sqlx::SqliteConnection` (a transaction derefs to one), through
`meta_store::Conn`; the shared crate's `postgres` and `sqlite` features pick the engines. Rows come
back as the model crate's own types, which stay free of sqlx. A subtype in a single-table
hierarchy writes its discriminator itself and reads only its own rows. Field names in a filter or
sort are the model's, checked at run time; which fields a caller may filter on is the transport's
choice, not the store's.

```rust
use meta_store::{Filter, Query};
use shop_store::order;

let mut c = sqlx::PgConnection::connect(&url).await?;
let page = order::list(&mut c, &Query {
    filter: Some(Filter::from_json(&json!({ "status": { "eq": "NEW" } }))?),
    limit: Some(50),
    ..Query::default()
}).await?;
// When `status` has transitions, it is a lifecycle and gets its guarded update:
if !order::transition_status(&mut c, id, &[OrderStatus::New], OrderStatus::InFlight).await? {
    // someone else moved it first
}
```

A view decides its own column types (`AVG` of an integer is `NUMERIC` on Postgres), so a served
read's numbers are read through a cast to their field's type, and a report's column is its derived
field's name under the project's column strategy.

A many-to-many relationship of a keyed entity gets `<relation>_of(c, id)`: the related rows,
read through the junction in one statement, in no order. The junction and its two keys are the
ones the loader's pairing rule derives (`metaobjects::validate::relationships::derive_m2m_fields`),
so a relationship that loads is one the store can follow. A `@symmetric` self-join answers from
both sides of a row, and a row relating a row to itself answers that row.

Not stored yet: a `@storage: flattened` field is refused at generation (`ERR_UNSUPPORTED`).

The store is held to the shared persistence corpus (`fixtures/persistence-conformance`):
`tests/persistence_conformance.rs` generates the corpus model, starts a throwaway Postgres
(`docker run --rm` on a tmpfs, removed when the test ends; without docker the test says so and
passes), and runs every scenario through the generated functions, normalized as
`normalization.md` says. All 56 run, `guarded-update` among them; a scenario this port could not run would go on the
ledger in that file, which is empty and only shrinks. `tests/repository.rs` runs the same
rows on SQLite in memory, and the guarded update on the rules model.

### `service`: the operations, with the rules

`service` ([ADR-0067](../../spec/decisions/ADR-0067-layering-and-the-service-seam.md) layer 4)
writes a `<package>_service` crate per package with a stored entity. Its `<Pkg>Service<D, A, P, B,
H, E>` is generic over the pool (`D`, a `sqlx::PgPool` or `SqlitePool`, through `meta_service::Db`)
and the actor type (`A`, whatever the transport resolves a caller to), and is built from what the
app writes:

- `P: <Pkg>Policy<A, C>`: `allows(permission, actor, row, input, conn)` answers whether the actor
  may run a command, a transition or an operation; the permission is the rules crate's enum;
- `B: <Pkg>Bodies<A, C>`: a method per declared operation. A command's body answers the move to
  make (`<Op>Move`, one variant per `@transitions` entry, or `None`) and its output;
  `BodyError::Business` answers one of the operation's declared errors;
- `H: <Pkg>Hooks<A, C>` (default `()`): `before` and `after` each derived create, update and
  delete, told which by `<Pkg>Before` and `<Pkg>After` (`<Pkg>Before::CreateOrder(&mut input)`,
  `UpdateOrder { patch, current }`, `DeleteOrder(&row)`); a before hook may change the input or patch;
- `E: <Pkg>Events<A, C>` (default `()`): `on_write`, after every write, inside its transaction.

Each derived operation and transition command is a method: `list_<entity>` (page size 50 unless
`api.pagination` says otherwise, and the total when the query asks `with_count`), `get_<entity>`,
`<relation>_of_<entity>`, `create_`, `update_`, `delete_`, and `<transition>_<entity>`; a declared
operation is `<operation>`. A write opens one transaction, or runs inside a caller's through its
`_in` twin (`create_order_in(&mut tx, ...)`), and a refusal anywhere undoes it. The checks run in
ADR-0066 §6's order: the row (404 `not_found`), validation (400), the permission point (403
`forbidden`), the state (409 `invalid_transition`), the body, the guarded update (409
`invalid_transition`, or `transition_condition_failed` when the row is in a legal state and the
`@condition` failed) and the event hook. An update that changes a lifecycle field is 409
`state_managed`, and so is a create naming a state other than the initial one (unless
`rules.create` allows any). An `@autoSet` timestamp is stamped by the service, whatever the caller
sent ([ADR-0045](../../spec/decisions/ADR-0045-generated-api-surface-owns-write-semantics.md)
Amendment 1). Every error is a `ServiceError`, whose `code()` and `status()` are the wire's.

`tests/service.rs` runs the rules corpus's scenarios (`fixtures/api-contract-conformance/rules/`)
through the generated service on SQLite, with the README's policy, bodies, hook and audit event, and
checks the settings variants in the generated text; an HTTP transport, and the shared API tests over
it, come next.

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
crate's build directory (`codegen/target`) and its `Cargo.lock` are left out. A crate it depends on by
`path` (a linked checkout of a pack's generators, say), in a build table or a `[patch]`, is an input
too, followed through that crate's own path dependencies and the workspace it inherits from. The
`metaobjects` and `metaobjects-codegen` engine crates are left out, because the engine's own hash
already covers their source; a path dependency on `metaobjects-render` is hashed like any other.

An owned generator need not be a copy. Each shipped generator has a parts trait (`EntityParts`,
`ClientParts`, `CommandsParts`, `RenderHelperParts`, `OutputParserParts`, `OutputPromptParts`) with
one default method per piece of its output (a crate's manifest, its `lib.rs`, one entity's file, one
item), and a generator of your own implements it, overrides the piece it changes and returns
`self.render(ctx)` from `generate`; every other file is the shipped generator's, byte for byte. An
override can call the shipped piece, a public function of the same module and name. The traits carry
the same no-stability caveat as the rest of the engine API (ADR-0063 item 7).

`cargo meta gen --list` shows each owned copy as `identical`, or as `DIFFERS` with how many shipped
lines it lacks and how many are its own.
`cargo meta eject --undo` removes copies that are still identical (`--force` discards an edited one)
and tells you the two lines of `codegen/main.rs` to change; it never edits that file.

Nothing discovers or loads a third-party generator: the owned crate is the supported way to add
your team's own generator. Write it against `metaobjects-codegen`'s authoring surface (the
`generator`, `emitted`, `plan`, `writer` and `names` modules) and add it to the generator list. That
surface is versioned with the crate under the [compatibility policy](../compatibility-policy.md); the
rest of the crate is internal and may change in any release (ADR-0065 Amendment 5). An owned copy is
pinned to the exact engine its `Cargo.toml` names.

The owned crate's `Cargo.toml` names no machine. By default the three engine crates are the crates.io
release the tool is, pinned exactly (`metaobjects = "=<version>"`), since an owned copy is that release's
source. Until a release exists, or to build against your own changes, eject with
`--engine <directory | git-url[#rev]>`: a directory is a checkout's `server/rust` (relative to the project
root), and a git URL names a repository and an optional revision.

### Conformance

The port runs the shared corpora below. Five of them keep a ledger: a fixture that fails and is not on
the port's ledger prints a warning and does not fail the `rust` lane until ADR-0065 turns the warning off; a
fixture that passed and regresses still fails it, because each ledger records what the port passes
today — a `minPassing` count, or (the render corpus) the cases that must still differ — and may only
shrink. The others have no ledger: each case asserts its result
outright.

| Corpus | Rust today |
|---|---|
| `registry-conformance` | byte-identical manifest |
| `conformance` (the metamodel corpus) | **584 of 584**, and the ledger is empty |
| `yaml-conformance` | 18 of 19. The one on the ledger, `yaml-ref-root-escape`, waits for the root-level `::` reference rules of [ADR-0059](../../spec/decisions/ADR-0059-references-resolve-once-after-the-tree.md), which are reference resolution, not a validation pass. |
| `source-resolution-conformance` | all 30 cases |
| `reference-source-conformance` | all 6 cases: a `reference: true` source loads so references resolve against it, a node declared only in reference files is a reference node no generator emits, and a `template.*` declared only there is refused (`ERR_REFERENCE_SOURCE_TEMPLATE`) |
| `naming-conformance` | all of it |
| `codegen-skip-conformance` | every case the port can meet, on both columns (what `gen` must do and what a local `verify --codegen` may do), including an edited owned generator and a forced CI verify ([ADR-0064](../../spec/decisions/ADR-0064-skip-codegen-when-nothing-changed.md)). The one it cannot meet, about the three-way merge, is named with its reason in the runner; the template cases (a body edited, a body added) run. |
| `rules-check-conformance` | all 16 cases: the diagnostics (severity, code, node address, message text) and the summary of the `verify` business-rules gate, under each case's `rules` and `verify` settings |
| `validation-conformance` | every case, through the generated `validate()`: each payload is read into the generated create body by a probe the real compiler builds |
| `decimal-wire`, `duration-wire` | every vector, against the code the support crate carries |
| `writer-conformance` | every `core` and `rust` case of the code writer ([ADR-0063](../../spec/decisions/ADR-0063-generators-own-layout.md)); each `rust` case is a rustfmt fixed point |
| `render-conformance` | every case, through `metaobjects_render::render`: escaping per format, partials, `has<Field>` and `-last`, the `maxChars` budget |
| `template-output-render-conformance` | the welcome page and email, the nested payload and the cross-package payloads, rendered through generated `render-helper` crates that a probe builds; the drift cases fail `gen`, and a body edited after generation fails the render |
| `verify-conformance` | all 45 cases through `cargo meta verify --templates`'s check. Two (`verify-set-delimiter-clean`, `verify-set-delimiter-drift`) carry a Rust expectation file, as other ports' files do where their engine reads a set-delimiter tag differently. |
| `generator-registry-conformance` | the shipped generators are exactly the registry's `rust` entries, with its tier and layer, and the eject contract's census, completeness and depth hold (ADR-0034 Amendment 8) |
| `render-conformance` | every case but the three the ledger holds — `render-shadowed-dotted-prefix`, `render-list-length`, `render-zero-falsiness` (`mustache-ng` has its own name lookup, data model and truthiness); a ledgered case must still differ, the rest render byte-identical through `metaobjects_render::render` (the Mustache engine underneath is `mustache-ng`) |
| `verify-conformance` | all 45 cases, through `metaobjects_render::verify`, with no ledgered case |
| `response-verify-conformance` | all 7 cases: the reply check the template gate adds — `ERR_RESPONSE_UNRESOLVED`, and, for an xml prompt, `ERR_RESPONSE_TAG_UNDECLARED` |
| `extract-conformance` | all 58 cases, through `metaobjects_render::extract::extract` |
| `output-prompt-conformance` | all 17 cases in all three `@promptStyle` styles, with the extract round trip, through `metaobjects_render::prompt::render_output_format` |

Three gates have no corpus of their own:

- **The codegen-compile gate.** The small two-package model and the public fitness model are generated
  by every shipped generator, each into a scratch Cargo workspace that `cargo check` builds and
  `rustfmt --check` reads file by file. A probe then uses the generated types and drives the generated
  client and commands over HTTP against a local server that records each request. The workspace
  resolves from a committed lockfile (`metaobjects-codegen/tests/gen-check.lock`), and the gate fails
  when cargo needed a package that lockfile does not name.
- **The scale gate.** Twenty copies of the fitness model, each its own package: the output must be
  exactly twenty times one copy's files and no more than twenty times its bytes, one copy's output has
  a byte budget and a longest-file budget, and all hundred and twenty-three crates must build. The times are
  printed; their ceilings are set far above a normal run and catch a step that stopped scaling, not
  a slow machine.
- **The layout ratchet** (ADR-0063 item 6, `metaobjects-codegen/tests/layout_ratchet.rs`). It parses
  every source file under `metaobjects-codegen/src/` except the writer, which covers the generators and
  the fixed text in `emitted/`, and it fails on a line break or an indentation run typed outside the
  writer. `tests/layout_ratchet/allowlist.json` names the files that write something other than
  generated code (terminal messages, hash input, JSON), each with a reason. The list only shrinks: the
  test compares it with the copy at the branch's merge base.

Rust is not yet a column in the [per-corpus table](../CONFORMANCE.md#per-corpus-totals); it joins
when the port runs the persistence and API-contract corpora, which need a service tier the port does
not have yet. It runs the render, extract and output-format corpora today.

### Load benchmark

`load_bench` (a Cargo example) times loading a 20-times model built in memory from the public
conformance fitness model, per load phase and per validation pass, with the peak memory of the
process. Its invocations, the baseline options and the committed baseline are documented in
[`scripts/bench-load/README.md`](../../scripts/bench-load/README.md#rust-load_bench).

[`scripts/bench-load/`](../../scripts/bench-load/README.md) runs this same model through every port,
stage by stage (load and validate, a no-change generation run, a full generation, a one-entity-edit
regeneration, peak memory), so a port's speed can be tracked per feature next to the others.

## What does not exist yet

- **Other generators.** There is no server-side route generator yet (the service has no HTTP
  transport) and no documentation generator. Projections and reports
  get no client or commands yet, and a template over a
  sourceless `object.projection` payload gets no render function.
- **Other gates.** `verify --codegen`, `verify --templates` and the business-rules gate are the ones
  it has. There is no requirement gate and no `fmt`.
- **A three-way merge.** A hand-edited generated file is refused by name, as in every port but
  TypeScript; change the model or own the generator instead.
- **The service tier.** No `ObjectManager` and no web adapters; data access is the generated
  store crates, and the generated `service` crates run the rules over them.
- **Publication.** The crates are publishable and the lane proves they package (`cargo publish
  --dry-run`), but nothing is published: there is no crates.io release yet, and publishing waits for
  the owner's go ([ADR-0065](../../spec/decisions/ADR-0065-rust-is-the-sixth-port.md) Amendment 3).

**A note on the name `cargo-meta`.** The crates.io name `cargo-meta` is held by an unrelated crate, so the
CLI package is `metaobjects-cli` and installs a `cargo-meta` binary: the command you type is still
`cargo meta`. Nothing is reserved on crates.io; reserving a name is a publish, and waits for the
owner's go.

The schema stays where it is for every port: migrations run in the project's own tool or the Node
`meta migrate` reference helper, and database checks in the Node `meta`
([ADR-0015](../../spec/decisions/ADR-0015-single-shared-migrate-engine.md);
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

The API carries no stability promise and may change; read `server/rust/metaobjects/tests/project_load.rs` for a
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
