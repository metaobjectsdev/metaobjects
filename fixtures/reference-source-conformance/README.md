# reference-source-conformance

Pins **reference sources**: a `sources` entry `{ "path": …, "reference": true }` in
`.metaobjects/config.json` whose files load (so references resolve against them) but whose
nodes no generator emits, because another generator run owns those types.

```
cases.json   # { cases: [{ name, note?, tree, config, expectReference? | expectLoadError? }] }
```

Each case:

- **`tree`** — project-root-relative path → file content, materialized under a fresh
  temp root.
- **`config`** — written to `<root>/.metaobjects/config.json`.
- **`expectReference`** — the **exhaustive** set of top-level resolution keys
  (`package::Name`) the port reports as reference nodes after a project-aware load,
  compared as an unordered set. `[]` means "loads, and nothing is a reference node."
- **`expectLoadError`** — instead of the above: the load must fail with exactly this code.

Rules the corpus pins:

1. A reference source's files load into the same root as every other source; a prompt's
   `@responseRef` naming a type there resolves (the first case shows the same tree failing
   `ERR_INVALID_TEMPLATE` without the reference source).
2. A top-level node is a reference node iff **every** file declaring it (overlays included) is
   a reference file. One declaration in an ordinary source makes it the project's own.
3. A file an ordinary source also reaches is ordinary.
4. A `template.*` declared only in reference sources is refused with
   `ERR_REFERENCE_SOURCE_TEMPLATE`.

What a port does with the set — exclude it from every generator's selection while a local
prompt's parser for a reference reply type still emits — is proven by each port's own
codegen test, since the emitted file names are per-port.

Runners: TypeScript `server/typescript/packages/sdk/test/reference-source-conformance.test.ts`
(reference implementation) and one per port; see `docs/CONFORMANCE.md`. Design:
`docs/features/metadata-sources.md`, "Reference sources".
