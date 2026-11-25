# Independent packs

A directory here is an **independent pack**: vocabulary, generators and runtime for a capability
that is not part of core, built and versioned as if it were its own repository
([ADR-0069](../spec/decisions/ADR-0069-independent-packs.md)).

| Pack | What it declares | Requires | Ports |
|---|---|---|---|
| [`config`](config/README.md) | settings groups, `@secret` / `@envName` / `@phase`, vaults (Infisical) and their scopes; `.env.example`, key manifest and `.keys-axi.toml` generators | core | TypeScript |
| [`systems`](systems/README.md) | systems, apps (service, client, job), resources | core | TypeScript |
| [`delivery`](delivery/README.md) | environments, builds, runtime processes, deployments, value bindings | `systems` | TypeScript |
| [`railway`](railway/README.md) | `deployment.railway` (vocabulary only; the emitter is later work) | `delivery` | TypeScript |
| [`cloudflare`](cloudflare/README.md) | `deployment.worker`, `deployment.pages` and a Worker's D1, KV, R2, queue and rate limiting bindings; `wrangler.jsonc`, token-scoped deploy, secret sync and doctor script generators | `delivery`, `config` | TypeScript |

An independent pack is not in the default bundle. A project opts in by naming its provider. It is
never in `fixtures/registry-conformance/expected-registry.json` and never moves
`metamodelVersion`. It has its own version, its own changelog, and its own list of the ports that
carry it. The bundled packs (`db`, `rules`, `reporting`, `requirements` and the others) are a
different kind: they ship inside each port's core package and do not live here.

## The one rule

A pack may depend on core and on other packs. **Core never depends on a pack.** Nothing outside
this directory names a pack package or a path in it, except the root workspace glob
`packs/*/typescript`. `scripts/check-pack-boundary.ts` (the `gates` lane) fails the build
otherwise.

## Layout

```
packs/<name>/
  pack.json             the manifest (below)
  CHANGELOG.md          this pack's changelog; pack work never writes the root CHANGELOG.md
  README.md
  metamodel/*.json      the vocabulary definition, in the spec/metamodel/ format
  fixtures/
    expected-vocabulary.json   the rows this pack adds to the default bundle (generated)
    conformance/<scenario>/    load fixtures, in the shared format; providers.json names the pack
    ERROR-CODES.json           only if the pack defines error codes of its own
  typescript/           @metaobjectsdev/pack-<name>, a member of the root Bun workspace
    package.json        peer @metaobjectsdev/metadata in the core range, dev workspace:*,
                        a "typecheck" script, "private": true while unpublished
    src/index.ts        exports `provider`, whose id is pack.json's id
    conformance-expected-failures.json   optional: the TypeScript port's known gaps
  java/ kotlin/ python/ csharp/ rust/   only for the ports pack.json lists
```

## `pack.json`

```json
{
  "id": "metaobjects-<name>",
  "version": "0.1.0",
  "stability": "preview",
  "requires": { "metamodel": ">=1.3 <2", "packs": {} },
  "ports": {
    "typescript": { "package": "@metaobjectsdev/pack-<name>", "core": ">=1.3.0 <2.0.0", "publish": false }
  }
}
```

| Field | Rule |
|---|---|
| `id` | `metaobjects-<name>`, the provider id |
| `version` | `X.Y.Z`; one number for every port; every pack starts at `0.1.0` |
| `stability` | `experimental`, `preview` or `stable` (`docs/features/stability-labels.md`); a pack starts `preview` |
| `requires.metamodel` | the metadata contract the vocabulary is written against, with an upper bound |
| `requires.packs` | `{ "<pack id>": "<range>" }` for packs in this directory, each range bounded |
| `ports.<port>.package` | npm `@metaobjectsdev/pack-<name>`, Maven `com.metaobjects.packs:<name>` (Kotlin `com.metaobjects.packs:<name>-<suffix>`), PyPI `metaobjects-pack-<name>`, NuGet `MetaObjects.Packs.<Name>`, Cargo `metaobjects-pack-<name>` |
| `ports.<port>.core` | the core range that port's native manifest states (npm peer range, NuGet `[1.3.0,2.0.0)`, PyPI `>=1.3,<2`, ...) |
| `ports.<port>.publish` | `false` until an estate project runs the pack with the drift gate enforced |

`scripts/check-pack-manifests.ts` (the `gates` lane) checks every field and checks that each
native manifest agrees with it.

## Checks

```
bun scripts/pack-vocabulary.ts <name> --write   # regenerate fixtures/expected-vocabulary.json
bun scripts/pack-vocabulary.ts <name>           # the pin is current and the pack leaves core alone
bun scripts/pack-conformance.ts <name>          # run fixtures/conformance/ through the TypeScript port
scripts/ci-local.sh --only packs                # all of the above, plus typecheck and the pack's tests
```

"Leaves core alone" means that composing the pack onto the default bundle changes no row of the
bundle's own registry manifest. A pack may add types, optional attributes and child rules on
bundle types (ADR-0050), and common attributes. It may change nothing the bundle declares.

The `packs` lane blocks for a change to a pack's own files. On a core change it runs as a
canary: a pack the change breaks is reported as a named SKIP and fixed in the pack's own pull
request.

## The port rule

A port either carries the pack's provider and passes its whole corpus, or does not carry it, in
which case a model that uses the pack fails there with an error naming what it does not know.
Bundled vocabulary keeps the stricter rule (every port registers it).
