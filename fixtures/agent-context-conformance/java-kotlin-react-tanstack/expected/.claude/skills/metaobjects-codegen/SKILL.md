---
name: metaobjects-codegen
description: Use when configuring or running MetaObjects code generation: generators/targets/dialect config, the gen command, and hand-edit-preserving regeneration.
---

# MetaObjects code generation

Codegen is the first pillar: MetaObjects reads your typed metadata and emits
**idiomatic per-language code** — entity types, DB tables/schemas, query helpers,
REST routes, validators, payload value-objects, output parsers. The metadata is the
durable spine; the generated code is a disposable artifact. It runs at runtime
**without any MetaObjects dependency** — if the libraries disappeared tomorrow, you
keep working code.

This skill is the port-agnostic procedure. The exact config file, generator names,
and command for *this* project's server language live in a reference fragment
(pointed to at the bottom).

## What codegen does

You run a `gen` step. The runner:

1. Loads all metadata under `metaobjects/` (the same loader the runtime uses).
2. Resolves output targets and precomputes shared render state.
3. Runs each configured **generator** — most emit one file per entity; some emit a
   single shared file (a barrel, a DB-context, an app-config).
4. Refuses to overwrite any file that does NOT carry the `@generated` header;
   overwrites the ones that do.

The output is normal idiomatic code in your language — you import it and use it
like any hand-written module.

## The `@generated` header + hand-edit-preserving regen

Every emitted file carries a `@generated` header. This is load-bearing:

- **Never hand-edit a file with a `@generated` header for a change you want to
  keep.** The next `gen` run overwrites it. If you need different output, change
  the metadata (or the template), not the generated file.
- **Hand-written regions are preserved by three-way merge.** Where the codegen
  supports designated hand-editable regions, regeneration runs a three-way merge
  (base → yours → newly-generated) so your edits survive a regen. Code review is
  the backstop: a diff on a `@generated` file that wasn't produced by `gen` is a
  smell.

Practical rule: **pattern-derivable-from-metadata = regenerate; business logic =
hand-write in a non-generated file.** FK columns, CRUD, validator chains,
type-safe finders, `relations()` blocks — all derived, never hand-coded. Custom
SQL views, regex from outside metadata, and domain logic are what you hand-write.

## Selecting generators by stable name

Codegen is a set of named generators you opt into. Each generator has a **stable
name** (kebab-case) that surfaces in diagnostics — reference generators by that
name, never by inlining what they emit. Typical generators cover: the entity
type/model, the DB table/schema, query/finder helpers, REST routes, client
form/grid/hook artifacts, filter + sort allowlists, payload value-objects, and
`template.output` parsers. You enable the subset your project needs; an abstract
entity never emits instance/write artifacts regardless.

Per-entity opt-outs exist (e.g. skipping client-side artifacts for a given
entity) and are set as attributes on the entity in metadata, not in code.

## Dialects

Generated DB schema/DDL targets a SQL **dialect**:

- `postgres` — the default, fullest-featured.
- `sqlite` — supported; rejects non-default DB schemas.
- `d1` (Cloudflare D1) — **TypeScript-only**. It is SQLite at the SQL level; the
  non-TS server ports have no analogue, so it never appears in their config.

Set the dialect once in the project's codegen config. Field subtypes map to the
dialect's column types deterministically (`field.string` + `@maxLength` →
`varchar(N)`, `field.currency` → integer, `field.uuid` → native `uuid` on
Postgres, `field.enum` → `varchar` + `CHECK`, etc.).

## Per-target output

Generated code can be routed to **multiple output directories/packages** so each
artifact lands with its runtime concern: the entity model in a database package,
routes in the API app, client hooks/forms/grids in the web app. Each generator can
declare which named target it writes to; same-target references stay relative,
cross-target references go through the target's configured import base. With no
targets configured, everything lands in a single output directory — output is
byte-identical to the single-directory case. Use multiple targets only when the
project's package boundaries justify it.

## Running gen

The shape is always the same — a `gen` verb that loads metadata, renders, merges,
and writes — but the binary differs per server language (the Node `meta`, a
language-native console tool, or a build-plugin goal). A dry-run mode previews
without writing; a watch mode re-runs on metadata changes where supported. Pass
specific entity names to scope a run to those entities.

---

For this project's server-language specifics (config file, generator names, the
gen command), read `references/<server>.md`.
