# Upgrading within 1.0 (1.0.x → a later 1.0.x)

A 1.0 patch never asks you to change metadata that worked, and `metamodelVersion` has stayed
`1.0` since the 1.0 cut. It can still change the code `meta gen` writes, and some of those
changes reach your app. This page lists what came up when nine adopter projects moved from
1.0.0–1.0.7 to 1.0.10: what to run, and what to look for afterwards. The per-release detail is
in `CHANGELOG.md`; read its **Upgrading** and **Behaviour change** lines for every version you
cross.

## The steps

1. **Bump every MetaObjects package together**: all `@metaobjectsdev/*` at the same version
   (npm), `metaobjects` (PyPI), `MetaObjects*` (NuGet), `com.metaobjects:*` at npm major + 7
   (Maven). Reinstall cleanly and read the resolved versions back.
2. **`meta upgrade`**, then `--apply` if it reports anything.
3. **Resync the generators you own.** `meta eject --list` reports each owned copy as identical
   to the new reference or not. An owned copy does not update itself: a project that only runs
   `meta gen` keeps running the generator logic from the version it ejected. For a copy you
   never edited, `meta eject <name> --force` takes the new reference. For one you edited,
   three-way merge it (`meta eject <name>` prints how) — `--force` discards your edits.
4. **`meta gen`**, then typecheck and run your tests. Read the generated diff: it is how you
   learn what changed.
5. **Schema.** If `meta gen` or `meta migrate --dry-run` reports a schema change, write the
   migration your usual way and read it before applying it (see "Views" below).
6. **Agent context.** `meta init --docs-only --refresh-docs` (or `npx meta agent-docs`) updates
   `.metaobjects/` and `.claude/skills/metaobjects-*`. A file you edited is left alone and the
   new copy is written beside it as `<file>.new`; merge it by hand and delete the `.new`.

## What to look for after `meta gen`

- **Re-ejecting `entity` / `routes` / `routes-hono` (1.0.9+) copies the HTTP adapter into
  `codegen/runtime/`** and points generated code at it by a relative path. In a monorepo whose
  output sits inside a workspace package, that path leaves the package and the package's build
  fails (`TS6059 … is not under 'rootDir'`). Either pass
  `runtimeImport: "@metaobjectsdev/runtime-ts"` to those generators to keep importing the
  published adapter, or move the copy inside the package. `meta gen` warns when it sees this.
- **Projection URLs (1.0.5).** A TypeScript projection is served at its snake_case plural,
  like every other port: `/trip-summaries` became `/trip_summaries`. Generated hooks follow
  automatically, and so does any client code that builds the URL from `<Entity>.$path`.
  Hard-coded URLs and tests that name the old path break, and the API and the web client must
  be deployed together.
- **Filter brackets are percent-encoded (1.0.5).** Generated clients send
  `filter%5Bstatus%5D=open`, not `filter[status]=open`. Servers decode both; a test that
  compares the raw query string needs to decode it first.
- **Template payload types (1.0.5).** A template's payload and response types are the value
  objects' own generated types, and `prompts.ts` holds only the render handles. Imports of a
  payload type from `prompts.ts` move to the value object's module. See
  [value-object-types-are-generated-once.md](value-object-types-are-generated-once.md).
- **Date and timestamp validation (1.0.9).** Generated write schemas check the shape of
  `field.date`, `field.time` and `field.timestamp` values, and store instants in UTC. A test
  that posts free text to one of those fields now gets a 400.
- **Generated forms with a blank optional date (1.0.9–1.0.10).** Those versions validated the
  blank `""` before normalizing it, so the create form never submitted. Fixed after 1.0.10;
  until you are on the fix, treat `""` as absent in an owned form generator.
- **Views (1.0.4).** When an entity has two foreign keys to the same target, the key an
  `origin.*` `@via` path follows is now the one the metadata names. A view that used to join on
  the other key is rewritten by the next `meta migrate`, and it can return different rows. Read
  that migration before applying it.
- **New advisories (1.0.9).** `meta verify` lists foreign keys with no covering index. It never
  fails a build; add an `index.lookup` (and a migration) where the join matters.
