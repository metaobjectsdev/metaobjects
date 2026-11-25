# The config pack (`metaobjects-config`)

Settings, secrets and where secrets live, declared in the model, and the files a project
needs from them. An **independent pack** ([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)):
version `0.1.0`, `preview`, unpublished, outside the default bundle and outside
`metamodelVersion`. A project opts in by naming its provider.

| | |
|---|---|
| Provider id | `metaobjects-config` |
| Ports | **TypeScript** (`@metaobjectsdev/pack-config`). No other port carries it yet; there, a model that uses it fails to load with `ERR_UNKNOWN_SUBTYPE` / `ERR_UNKNOWN_ATTR` naming what it does not know (ADR-0069, the port rule). |
| Requires | core `>=1.3.0 <2.0.0`; no other pack |

It answers one question: *what does this application need to be told, and which of it is
secret?* It holds vocabulary and generators only, never the facts of an estate. Deployment
vocabulary (environments, deployments, platforms) belongs to the `systems` and `delivery`
packs, which refer to this pack's nodes by name.

## Vocabulary

| Node | What it is |
|---|---|
| `object.settings` | A settings group. Each field is one setting: its type, `@required`, `@default`, `@description` and validators work as on any field. Scalar field subtypes only (an environment variable holds one value). It has no source, so it generates no table, query or route. |
| `@secret` (field, boolean) | The value is a secret: it lives in a vault, never in the model or in generated output. A secret setting may not declare `@default`. |
| `@envName` (field, string) | The environment variable name, when the derived one is wrong. Derived: `<GROUP>_<FIELD>` in upper snake case, so `Database.url` is `DATABASE_URL` and `Database.poolSize` is `DATABASE_POOL_SIZE`. |
| `@phase` (field, `runtime` \| `build`) | When the setting is read. Absent means `runtime`; `build` is a build-time variable, such as a Docker build argument. |
| `vault.infisical` | An Infisical secret store, at the document root. `@defaultScope` names the scope used when no environment is given. |
| `scope.env` | Where the vault keeps one environment's secrets. Its name is the model's environment name; `@project` is the Infisical project; `@env` is Infisical's environment slug (absent: the scope's name). |

The three field attributes are registered on every field subtype (a pack may add optional
attributes to a type it does not own, ADR-0050); the generators read them on settings only,
and the first of them to run warns, naming the field, when a model puts one anywhere else. An
abstract settings group is a base: its settings appear under each group that extends it, not
under its own name.
A secret is never referenced by value or by a separate node: it is read under its
environment name, in the scope the vault maps to the environment being deployed.

```json
{ "metadata.root": { "package": "acme::app", "children": [
  { "object.settings": { "name": "Database", "children": [
    { "field.string": { "name": "url", "@required": true, "@secret": true } },
    { "field.int": { "name": "poolSize", "@default": 10, "@envName": "DB_POOL_SIZE" } }
  ]}},
  { "vault.infisical": { "name": "keys", "@defaultScope": "dev", "children": [
    { "scope.env": { "name": "dev", "@project": "acme-app" } },
    { "scope.env": { "name": "production", "@project": "acme-app-prod", "@env": "prod" } }
  ]}}
]}}
```

## Generators

| Generator | Writes | Holds |
|---|---|---|
| `envExampleFile()` | `.env.example` | Every setting by name, grouped; the default of a non-secret setting; a comment line with type, required, secret and build-time |
| `keyManifestFile()` | `keys.manifest.json` | Every setting's name, model name, type, required, secret, phase and default, sorted by name; each vault and its scopes. What a deploy or doctor script compares a vault and a platform against |
| `keysAxiTomlFile({ vault? })` | `.keys-axi.toml` | The vault's backend, default scope and one `[environments.<slug>]` table per scope, the file `keys-axi` reads so `keys-axi run` needs no project flag. Name the vault when the model declares more than one |

Each takes `path` and `target`. No value of a secret ever reaches their output: the model
holds none. A problem the loader cannot see fails the run with every such problem listed, each
naming its node. These include: two settings on one variable name; a malformed `@envName`; a
derived variable name that is not valid; a setting that is not a scalar field, or is an array;
a secret with a default; a `@defaultScope` naming no scope; two scopes on one Infisical
environment; a vault with no scope. An abstract group is checked for all of these except name
collisions, which are checked under each group that extends it.

### Wiring

These files belong at the project root, so give them a target whose `outDir` is `"."`. The
top-level `outDir` and `dialect` are the project's own existing settings: `meta gen` requires a
top-level `outDir`, and `dialect` is needed when the model also has a persisted entity.

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { configProvider, envExampleFile, keyManifestFile, keysAxiTomlFile } from "@metaobjectsdev/pack-config";

export default defineConfig({
  outDir: "src/generated", // the project's existing setting
  dialect: "postgres", // the project's existing setting
  providers: [configProvider],
  targets: { root: { outDir: "." } },
  generators: [
    envExampleFile({ target: "root" }),
    keyManifestFile({ target: "root" }),
    keysAxiTomlFile({ target: "root" }),
  ],
});
```

Vaults, like settings, are read inside the project's `scope`. `meta gen` runs no generator over
a model with no object at all, so a model whose only declaration is a vault writes nothing.

## Checks

```
bun scripts/pack-vocabulary.ts config      # the pinned vocabulary; leaves core alone
bun scripts/pack-conformance.ts config     # fixtures/conformance/ through the TypeScript port
(cd packs/config/typescript && bun run typecheck && bun test)
```

`metamodel/config.json` is the vocabulary's definition; `typescript/src/config-definition.embedded.ts`
is a copy of it (`bun run embed` in `typescript/` rewrites it, and a test fails while it is stale).
