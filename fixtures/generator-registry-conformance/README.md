# generator-registry conformance

The canonical cross-port manifest of **stable generator names** (ADR-0021 D3).
`registry.json` is the single source of truth; every port's generator registry is
conformance-tested against it.

## The contract each port's test enforces

Given the port's own generator registry (stable-name → generator), the port's
conformance test asserts:

1. **No rogue names** — every stable name the port registers appears in
   `registry.json`.
2. **Presence both ways** — for every manifest entry whose `ports` array includes
   this port, the port's registry exposes that name; and the port does **not**
   expose a name whose `ports` array omits it.
3. **Tier agreement** — a name marked `tier: "neutral"` is flagged neutral in the
   port (owned by `meta docs`, not the recommended native suite).
4. **Layer agreement** — a name's `layer` matches the port's registry entry.

Because all five ports validate against this one file, a **shared concept is
spelled identically everywhere** (e.g. the REST surface is `routes` in every
port, never `controller`/`router`). That cross-port spelling stability is the
whole point.

## `layer` — the six values, and why six

`layer` is the grouping an adopter (increasingly an LLM in their repo) **selects
by**. Codegen is opt-in: nothing runs until it is chosen, so the catalog's job is
to make the choice cheap, and `layer` is the axis it is cheap along.

| layer | members | chosen by |
|---|---|---|
| `model` | entity, names, barrel, dto, value-object | app shape |
| `persistence` | queries, db-context, repository, exposed-table, relations, stored-proc | app shape |
| `api` | routes, routes-hono, filter-allowlist, validator, spring-config | app shape |
| `client` | form, hooks, grid, grid-hook | app shape |
| `docs` | docs, mermaid-er, api-docs | on by default (`meta docs`) |
| `capability` | prompt-render, output-parser, output-prompt, extractor, render-helper, payload, trace-helper, requirement-tests, shared-model, template, callable | `meta gen --list --probe` |

Six, not ten. An earlier draft split `capability` into `trace` / `requirements` /
`publish` / `primitive`, each with **one member** — a layer with one member does
no grouping work, and the split conflated two different kinds of choice. The
first four layers are app-shape decisions a builder makes. `capability` holds the
ones the **model has already made**: nobody picks `prompt-render` by browsing a
taxonomy, they pick it because they declared a `template.prompt`. `--probe`
constructs every generator and dry-runs it against the real model, so
`output-parser: 3, callable: 0, requirement-tests: 7` is strictly better
information than a category name — and unlike a category name it cannot go stale,
because it does not describe the generators, it runs them.

`capability` looking like a large undifferentiated bucket is therefore the point,
not a defect to be tidied. Do not add a seventh value to make it look tidier.

`layer` rather than a reuse of "tier", which is already taken twice
(native/neutral in ADR-0020, and server/UI elsewhere).

## Shared (cross-port) names

These concepts MUST use the same stable name wherever a port implements them:
`entity`, `routes`, `output-parser`, `output-prompt`, `render-helper`,
`extractor`, `template`, `filter-allowlist`, `payload`.

## Changing the surface

Adding, removing, or renaming a generator means editing **both** `registry.json`
**and** the port's registry in the same change — the conformance gate fails on
any drift (a typo'd name, a missing registration, a port that quietly diverges).
This is the mechanism that keeps the codegen surface coherent as it grows.

## Port ids

`typescript`, `csharp`, `java`, `kotlin`, `python`.
