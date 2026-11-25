# cloudflare pack

`metaobjects-cloudflare`, version 0.1.0, **preview**, unpublished. An independent pack
([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)). Requires
[`delivery`](../delivery/README.md) and [`config`](../config/README.md).

Cloudflare as a deployment platform. It registers `deployment.worker` (a Worker, with or without
static assets) and `deployment.pages` (a Pages site), and the bindings a Worker reaches its
resources through. It generates the Worker's `wrangler.jsonc` and the scripts beside it: a
wrangler wrapper that runs as the deployment's narrow API token, a deploy script, a script that
copies the declared secrets from the vault to Cloudflare, a doctor script, and the facts no file
holds. The generators write files and stop: MetaObjects never talks to Cloudflare or to a vault.
The scripts do, with `wrangler` and `keys-axi`, when someone runs them.

## Vocabulary

| Node | Attributes |
|---|---|
| `deployment.worker` | every `deployment.base` attribute (`@app`, `@environment`, `@domains`, `@branch`, `@secrets`, and `value.*` children), plus `@compatibilityDate` (required), `@tokenSecret` (required), `@script` (the Worker's name; absent: the app's), `@main`, `@compatibilityFlags`, `@workersDev`, `@assetsBinding`, `@notFound`, `@workerFirst` or `@workerFirstPaths`, `@jobs`, `@tokenVault`, `@extra` |
| `deployment.pages` | every `deployment.base` attribute, plus `@project` (required), `@tokenSecret` (required), `@tokenVault` |
| `cloudflare.d1` | `@databaseName` (required), `@databaseId`, `@migrationsDir` |
| `cloudflare.kv` | `@namespaceId` (required) |
| `cloudflare.r2` | `@bucketName` (required) |
| `cloudflare.queue` | `@queue` (required) |
| `cloudflare.ratelimit` | `@namespaceId`, `@limit`, `@period` (all required; the period is 10 or 60) |

The `cloudflare.*` nodes are children of a `deployment.worker`. A D1, KV, R2 or queue binding is
named after the resource it places, one the app `@needs` (`resource.database`, `.keyvalue`,
`.bucket`, `.queue`); its binding name is the node's name in upper snake case (`rateLimit` is
`RATE_LIMIT`). A rate limiter places no resource and is named freely. Every resource the app needs
that Cloudflare manages must be bound in every environment; a resource with `@managedBy: external`
is reached through settings and listed, not bound.

The token: the deploy scripts read `@tokenSecret` and `CLOUDFLARE_ACCOUNT_ID` from the
environment's scope of `@tokenVault` (absent: the `@secrets` vault). The scope is the one named
after the environment, else the vault's `@defaultScope`, so one deploy-token scope can serve every
environment.

`@extra` is the escape hatch: a JSON object of Wrangler keys this pack does not model
(`placement`, `observability`, ...), copied into the environment's block. A key the generator
writes itself is refused. A key Wrangler fills into an env block that omits it (`observability`,
`placement`, `limits`, `rules`, ...) is set in every environment or in none, like `@main`.

### One abstract deployment, one per environment

What every environment shares (the app, the entry module, the compatibility date, the assets
behaviour, the token, the bindings) sits on an abstract `deployment.worker`; each environment's
deployment `extends` it and holds only what differs: `@environment`, `@domains`, `@branch`, a
binding with that environment's ids, a value. A child the extender redeclares by name replaces
the inherited one. The generators read through `extends`, so an inherited binding or value counts,
and they skip the abstract base.

## Generators

| Generator | Writes | What it is |
|---|---|---|
| `wranglerConfigFile()` | `wrangler.jsonc` | The Worker's configuration (Workers only) |
| `cloudflareRunnerScript()` | `deploy/cloudflare/wrangler.sh` | Runs wrangler as the environment's narrow token: `keys-axi run` reads it and `CLOUDFLARE_ACCOUNT_ID`, the global-key variables `CLOUDFLARE_EMAIL` and `CLOUDFLARE_API_KEY` and any `CLOUDFLARE_API_TOKEN` the shell holds are unset, the vault's token becomes `CLOUDFLARE_API_TOKEN`, and `npx wrangler@4.168.0` runs (`WRANGLER_VERSION` overrides) |
| `cloudflareDeployScript()` | `deploy/cloudflare/deploy.sh` | Exports the build-time settings the model gives values, builds (the app's `build.command` or `build.static @command`), syncs the secrets, then `wrangler deploy [--env <name>]` or `wrangler pages deploy <dir> --project-name --branch --commit-hash` |
| `cloudflareSyncSecretsScript()` | `deploy/cloudflare/sync-secrets.sh` | Copies each secret setting from its vault scope to the Worker (`wrangler secret put`) or to the Pages project's environment the deployment serves (`wrangler pages secret put --env production` or `preview`), the value through a pipe |
| `cloudflareDoctorScript()` | `deploy/cloudflare/doctor.sh` | Checks, by name only, that the token, the account id and each secret are in the vault, that each secret is on Cloudflare (the Worker, or the Pages project's environment the deployment serves), that the configuration builds (`wrangler deploy --dry-run`), and that each domain answers |
| `cloudflareUnexpressedFile()` | `deploy/cloudflare/unexpressed.md` | Per deployment, each fact the files do not hold and how it is carried instead |
| `cloudflareFiles()` | all six | The six generators with the same options |

Each takes `{ target?, app?, topLevel?, paths? }`. One set of files is for one app: a model that
deploys several apps to Cloudflare needs `app`. `topLevel` is the environment written at the top
level of `wrangler.jsonc` (what `wrangler deploy` with no `--env` deploys); absent, it is the only
environment, else `production`. `paths` moves any file; the scripts name each other and the
configuration by those paths, so pass every generator the same.

### What `wrangler.jsonc` says

| Model | `wrangler.jsonc` |
|---|---|
| `@script` | `name`; in an env block `<top-level name>-<environment>` (Wrangler's own default) unless the deployment's `@script` differs, and two environments never deploy one Worker |
| `@main`, `@compatibilityDate`, `@compatibilityFlags`, `@workersDev` | `main`, `compatibility_date`, `compatibility_flags`, `workers_dev` |
| `@domains` | `routes`, each a custom domain |
| the app's `build.static @directory`, `@assetsBinding`, `@notFound`, `@workerFirst` / `@workerFirstPaths` | `assets.directory`, `.binding`, `.not_found_handling`, `.run_worker_first` |
| `@jobs` (each an `app.job`) | `triggers.crons`, from each job's `@schedule` |
| the app's non-secret runtime settings | `vars`: a `value.literal` here, else the `@default`; a required one with neither is refused |
| the app's `@secret` runtime settings | `secrets.required` (names only; the sync script copies the values) |
| `cloudflare.d1` / `.kv` / `.r2` / `.queue` / `.ratelimit` | `d1_databases`, `kv_namespaces`, `r2_buckets`, `queues.producers`, `ratelimits` |
| `value.ref` of another Cloudflare-deployed app's `host` / `publicUrl` | its first `@domains` entry in the same environment (`publicUrl` is `https://` and the domain, with the ref's `@path` appended) |
| the app's build-time settings | not in the file: `deploy.sh` exports each one the model gives a value, for the build to read |

Wrangler does not inherit `vars`, `secrets` or any binding into an `env` block, and a key it does
inherit is easy to forget. So every env block is written in full: every key the top level has,
with that environment's own value, an empty one included. Every fact carries a `//` comment naming
the model node it came from, `(from <base>)` when an environment inherits it. Paths are rewritten
relative to the file.

A Pages site has no `wrangler.jsonc`: `wrangler pages deploy` takes the directory, project and
branch as arguments, and the Pages project keeps its environment variables and domains in its own
settings (both are listed in `unexpressed.md`).

A Pages project has two environments, `production` and `preview`, each with its own variables and
secrets. The upload of the project's production branch serves `production` and every other upload
serves `preview`. The model states the production branch with the `@branch` of the
`deployment.pages` in the environment named `production`: a deployment serves `production` when
its `@branch` is that branch, and `preview` otherwise. The scripts pass that environment to
`wrangler pages secret put|list --env`, so one environment's secrets never land in another's.

Build-time settings (`@phase: build`) are not Cloudflare settings. `deploy.sh` exports each one
the model gives a value (a `value.literal`, else the `@default`) and then runs the app's build
command, when it has one; whatever builds an app without one reads them from its own environment.
A build-time `@secret` and a build-time `value.ref` are refused: the scripts copy a secret to
Cloudflare, never to a build, and resolve no reference on the deploying machine.

### Checks

The generators refuse, naming each node, a model Cloudflare could not deploy: a binding for a
resource the app does not need, a needed resource with no binding in some environment, a binding
name used twice in the Worker's env, a rate limiter period other than 10 or 60, a required setting
with no value, a value for a secret setting or for a setting the app does not read, a `value.ref`
Cloudflare cannot resolve, a build-time secret setting or a build-time `value.ref`, `@jobs` that
are not scheduled jobs, both worker-first forms, asset attributes with no `build.static`, a Worker
with neither `@main` nor assets, a secret setting with no vault, a vault with no scope for an
environment, `@main`, `@workersDev`, assets or an inheritable `@extra` key set in some
environments and not others (Wrangler would fill the gap from the top level), an `@extra` that is
not a JSON object or sets a generated key, two environments deploying one Worker, one app deployed
both as a Worker and as a Pages site, a Pages deployment that reads a secret when the model does
not say which branch is the production branch, two Pages deployments that serve one Pages
project's environment and read their secrets from different vault scopes, several apps without
`app`, and several environments with no top level.

### Wiring

These files belong at the repository root, so give them a target whose `outDir` is `"."`. As for
the config pack, `meta gen` runs no generator over a model with no object at all: systems,
deployments and vaults are not objects, so the model needs its settings groups (`object.settings`)
for these files to be written.

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { cloudflareFiles, provider as cloudflareProvider } from "@metaobjectsdev/pack-cloudflare";
import { configProvider } from "@metaobjectsdev/pack-config";
import { provider as deliveryProvider } from "@metaobjectsdev/pack-delivery";
import { provider as systemsProvider } from "@metaobjectsdev/pack-systems";

export default defineConfig({
  outDir: "src/generated", // the project's existing setting
  providers: [systemsProvider, deliveryProvider, configProvider, cloudflareProvider],
  targets: { root: { outDir: "." } },
  generators: [...cloudflareFiles({ target: "root" })],
});
```

## Fixtures

- [`cloudflare-worker-environments/`](fixtures/conformance/cloudflare-worker-environments/): a
  Worker with static assets, a D1 database and a KV namespace in production and staging, from one
  abstract `deployment.worker`. Staging redeclares the two bindings with its own ids and overrides
  one value; everything else it inherits.
- [`cloudflare-worker-cron-ratelimits/`](fixtures/conformance/cloudflare-worker-cron-ratelimits/):
  a Worker in front of its assets for every request, with a daily job, D1 with its migrations
  directory, R2, five rate limiters, three plain settings and five secrets, off workers.dev.
- [`cloudflare-pages-site/`](fixtures/conformance/cloudflare-pages-site/): a static site on Pages,
  production and a preview branch from one abstract `deployment.pages`.
- [`cloudflare-pages-secrets/`](fixtures/conformance/cloudflare-pages-secrets/): a Pages site
  whose Pages Functions read a secret, with one value for the production branch and one for a
  preview branch: each `deploy.sh <environment>` copies to that environment.
- `error-*`: a concrete Worker missing `@compatibilityDate`, an unknown `@notFound`, a binding
  under a Pages site, an authored `cloudflare.base`, an `@app` that resolves to nothing.

Names, domains, ids and token names are placeholders. The generated files are in
[`typescript/test/golden/`](typescript/test/golden/).

The first three success fixtures are modelled on three adopters' hand-written Cloudflare configuration
(a `wrangler.jsonc`, a `wrangler.toml` and a Pages deploy script). The bar is coverage, not
identity: `typescript/test/coverage.test.ts` checks every fact of each, with its values replaced
by the placeholders, fact by fact. Where the generated files go further:

- `wrangler.jsonc` validates against Wrangler's own JSON schema (vendored in
  `typescript/test/wrangler-schema/`), and points editors at it with `$schema`;
- rate limiters are the first-class `ratelimits` key, not untyped `unsafe.bindings`;
- environments are correct by construction: every env block repeats every key with its own value,
  where Wrangler would silently drop vars and bindings it does not inherit;
- the Worker's secrets are declared (`secrets.required`), so a missing one is a deploy error
  rather than a runtime surprise, and their values come from the vault through the sync script;
- every fact names the model node it came from; the facts no file can hold are listed in
  `deploy/cloudflare/unexpressed.md` instead of dropped;
- every Wrangler call runs as the environment's narrow token with the global-key variables unset,
  and the doctor checks the vault, Cloudflare, the build and the domains by name.

## Ports

TypeScript only.
