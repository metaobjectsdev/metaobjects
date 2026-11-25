# railway pack

`metaobjects-railway`, version 0.1.0, **preview**, unpublished. An independent pack
([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)). Requires
[`delivery`](../delivery/README.md) and [`config`](../config/README.md).

Railway as a deployment platform. It registers `deployment.railway`, and it generates Railway's
Infrastructure as Code file `.railway/railway.ts` with the files beside it: the facts that file
cannot hold, a script that copies the declared secrets from the vault to Railway, a deploy script,
a doctor script and a deploy skill. The generators write files and stop: MetaObjects never talks to
Railway or to a vault. The scripts do, with the `railway` and `keys-axi` CLIs, when someone runs
them.

## Vocabulary

| Node | Attributes |
|---|---|
| `deployment.railway` | every `deployment.base` attribute (`@app`, `@environment`, `@domains`, `@replicas`, `@region`, `@branch`, `@secrets`, and `value.*` children), plus `@project` (required), `@service` (absent: the app's name), `@repo` (GitHub `owner/name`) or `@image` (a container image), and `@checkSuites` (whether a deploy waits for GitHub check suites; absent leaves Railway's setting alone) |

A `deployment.railway` is held to the delivery pack's references: `@app` must name an `app.*`,
`@environment` an `environment.*` (`ERR_DELIVERY_UNRESOLVED_REF`).

## Generators

| Generator | Writes | What it is |
|---|---|---|
| `railwayTsFile()` | `.railway/railway.ts` | The Railway project in the `railway/iac` DSL (`railway` npm package 3.17.0): one named partial, one branch per environment, one `service()` per deployment |
| `railwayUnexpressedFile()` | `deploy/unexpressed.md` | Per deployment, each fact the file does not hold and how it is carried instead |
| `railwaySyncSecretsScript()` | `deploy/sync-secrets.sh` | Copies each secret setting from its vault scope to the Railway service (`keys-axi run`, then `railway variable set --stdin --skip-deploys`) |
| `railwayDeployScript()` | `deploy/deploy.sh` | Syncs the secrets, then `railway config plan` and `apply`; `--redeploy` redeploys and waits for the health path; then runs the doctor |
| `railwayDoctorScript()` | `deploy/doctor.sh` | Checks, by name only, that each secret is in the vault and on Railway, that the file matches Railway (`railway config plan --detailed-exit-code`), and that each domain answers on the health path |
| `railwayDeploySkill()` | `.claude/skills/deploy/SKILL.md` | How an agent deploys with those scripts, and the rules it keeps |
| `railwayFiles()` | all six | The six generators with the same options |

Each takes `{ path?, target?, project?, partial? }`. A model that deploys to more than one
Railway project needs `project`, since one file declares one project. `partial` defaults to the
service's name when the project has one service, else the project's name.

### What the file says

| Model | `.railway/railway.ts` |
|---|---|
| `@repo` / `@branch` / `@checkSuites`, or `@image` | `source: github(repo, { branch, checkSuites })` or `image(ref)`. One of `@repo` and `@image` is required: a plan of a service with no source disconnects it |
| `build.* @watchInclude` / `@watchExclude` | `build.watchPatterns`: the inclusions (`**` when there are none), then each exclusion with `!` |
| `build.dockerfile @path` | `build.builder: "DOCKERFILE"`, `build.dockerfilePath` |
| `build.command @command` | `build.buildCommand` |
| the first `runtime.process` | `deploy.startCommand`, `healthcheckPath`, `healthcheckTimeout`, `restartPolicyType` (`always` `ALWAYS`, `onFailure` `ON_FAILURE`, `never` `NEVER`), `drainingSeconds` |
| `app.job @schedule` | `deploy.cronSchedule` |
| `@domains` | `domains`, each with the process's `@port` when it has one |
| `@replicas`, `@region` | `replicas`, per region when `@region` is set |
| `value.literal` | an `env` entry with the literal |
| `value.ref` of a database or cache | the Railway reference to its template's variable (`${{db.DATABASE_URL}}`; postgres, mysql, redis, mongo) |
| `value.ref` of another app | `host` `${{svc.RAILWAY_PRIVATE_DOMAIN}}`, `port` its `@port`, `privateUrl` `http://${{svc.RAILWAY_PRIVATE_DOMAIN}}:port`, `publicUrl` `https://${{svc.RAILWAY_PUBLIC_DOMAIN}}`, with `@path` appended |

Variables: when no deployment in the project declares a `value.*` node, the file says
`variables: { managed: false }` and an apply changes no variable. The CLI reads that key and the
railway 3.17.0 SDK's types do not declare it yet, so the file spreads it from a constant
(`...unmanagedVariables`): the file type-checks against the SDK, where an object literal would not.
When one does, the file manages every variable of its services: each setting of the app's
`@settings` groups is declared, a secret as `preserve()` (the sync script sets it), a non-secret
with no value as its `@default` or `preserve()`. An apply deletes a variable a managed file does not
declare, so in that case every app in the project must read its settings groups.

The file is a named partial: databases, volumes and anything else it does not declare are left as
they are. Railway does not read the file during a deploy; `railway config apply` does, against the
linked environment, with the SDK installed beside it
(`npm install --no-save --prefix .railway railway@3.17.0`, which `deploy.sh` and `doctor.sh` run).

### Checks

The generators refuse, naming each node, a model whose deploy Railway could not do: a deployment
with no source or two, a secret setting with no vault (`@secrets`) or no scope for the
environment, a vault other than `vault.infisical`, a value for a secret setting or for a setting
nobody declared, a reference to a resource managed outside Railway or to an output its engine does
not supply, an `@settings` group that is not in the model, an app with no settings in a managed
file, and a partial name Railway refuses. (A `value.ref` asking for an output its producer lacks,
such as `@path` on a non-URL output, fails the load in the delivery pack.)

### Wiring

These files belong at the repository root, so give them a target whose `outDir` is `"."`. As for
the config pack, `meta gen` runs no generator over a model with no object at all: systems,
deployments and vaults are not objects, so the model needs its settings groups (`object.settings`)
for these files to be written.

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { configProvider } from "@metaobjectsdev/pack-config";
import { provider as deliveryProvider } from "@metaobjectsdev/pack-delivery";
import { provider as railwayProvider, railwayFiles } from "@metaobjectsdev/pack-railway";
import { provider as systemsProvider } from "@metaobjectsdev/pack-systems";

export default defineConfig({
  outDir: "src/generated", // the project's existing setting
  providers: [systemsProvider, deliveryProvider, configProvider, railwayProvider],
  targets: { root: { outDir: "." } },
  generators: [...railwayFiles({ target: "root" })],
});
```

## Fixtures

- [`railway-worked-example/`](fixtures/conformance/railway-worked-example/): an app's systems model
  (one service with its build and process facts, a database, a cache, an outside bucket, two
  outside systems, a production deployment with a database URL by reference and a literal profile)
  and an estate repository's additions (a staging environment and deployment it declares itself,
  and an overlay that runs production on two replicas).
- [`railway-emit-one-service/`](fixtures/conformance/railway-emit-one-service/): one Spring service
  from one repository, unmanaged variables, secrets from the vault. Its generated files are in
  [`typescript/test/golden/`](typescript/test/golden/).
- [`railway-emit-two-services/`](fixtures/conformance/railway-emit-two-services/): two services
  from one monorepo, each built from its own directory, one calling the other over Railway's
  private network, managed variables.
- [`railway-emit-environments/`](fixtures/conformance/railway-emit-environments/): one service in
  production and staging from one abstract `deployment.railway` that holds what both share (app,
  project, service, repository, a value); each environment's deployment `extends` it and holds its
  own `@environment`, `@branch`, `@domains`, `@replicas` and values, and staging overrides the base
  value by reusing its name. The abstract base is never rendered as a service. The pattern is
  described in the delivery pack's README ("One abstract deployment, one per environment").

Names, domains, repositories and project names are placeholders.

The `railway-emit-one-service` and `railway-emit-two-services` fixtures are modelled on two
adopters' hand-written Railway configuration (a hand-migrated `.railway/railway.ts`, and two
`railway.json` files). The bar is coverage, not identity: `typescript/test/coverage.test.ts`
evaluates the generated file and checks that every
fact of that configuration is in it, fact by fact (source, watch patterns, Dockerfile path, health
check, restart policy, draining, variable policy). Where the generated file goes further:

- it type-checks against the railway SDK;
- each service carries a comment naming the app and deployment it comes from, and each variable
  the node it comes from;
- secrets are never written: they are `preserve()` and the sync script copies them from the vault;
- the facts the format cannot hold are listed in `deploy/unexpressed.md` instead of dropped;
- domains, the health path and every reference to another service come from the model.

## Ports

TypeScript only.
