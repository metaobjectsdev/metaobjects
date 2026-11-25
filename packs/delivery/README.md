# delivery pack

`metaobjects-delivery`, version 0.1.0, **preview**, unpublished. An independent pack
([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)). Requires
[`systems`](../systems/README.md).

It answers: **what runs where, and what differs per environment?** Facts true in every
environment sit under the app (how it is built, how its process runs). A deployment places one app
in one environment on one platform, and holds only what differs there.

## Vocabulary

| Node | Where | What it is | Attributes |
|---|---|---|---|
| `environment.standing`, `.ephemeral`, `.local` | document root | A named environment: production, a pull-request preview, a workstation | (documentation only) |
| `build.dockerfile` | under an `app.*`, at most one build | Built as an image from a Dockerfile | `@path`, `@context`, `@watchInclude`, `@watchExclude` |
| `build.command` | under an `app.*` | Built by a command the platform's builder runs | `@command`, `@watchInclude`, `@watchExclude` |
| `build.static` | under an `app.*` | A directory of files served as they are | `@directory`, `@command`, `@watchInclude`, `@watchExclude` |
| `runtime.process` | under an `app.*` | How one of its processes runs | `@command`, `@port`, `@healthPath`, `@healthTimeoutSeconds`, `@drainSeconds`, `@restart` (`always`, `onFailure`, `never`) |
| `deployment.<platform>` | document root | An app in an environment on a platform. A **platform pack** registers the subtype (the [`railway`](../railway/README.md) pack registers `deployment.railway`) | `@app`, `@environment`, `@domains`, `@replicas`, `@region`, `@branch`, `@secrets`, plus the platform's own |
| `value.literal` | under a deployment | A setting's fixed value there | `@setting`, `@literal` |
| `value.ref` | under a deployment | A setting's value produced by another node at deploy time | `@setting`, `@producedBy`, `@output`, `@path` |

`deployment.base` is the abstract anchor platform packs specialise (`extendsBase: true`); this pack
registers no concrete deployment, and an authored `deployment.base` fails to load
(`ERR_ABSTRACT_SUBTYPE_AUTHORED`). A secret needs no value node: the setting is marked secret in
the config pack and the deployment names its vault in `@secrets`. The full definition is
[`metamodel/delivery.json`](metamodel/delivery.json).

## References

- `@app` names an app as `System.app`, or `pkg::System.app` from another package.
- `@environment` names an `environment.*` node.
- `value.ref`'s `@producedBy` names a `resource.*` or `app.*` the same way. A deployment sits at the
  document root, in no system, so these are always written `System.child`: a bare name finds
  only a top-level node. `@output` says which of its
  values (`url`, `host`, `port`, `user`, `password`, `privateUrl`, `publicUrl`), for a platform
  generator to map. This is how an address
  stays out of a repository: it is named, never written.

## Uniqueness

- A deployment holds at most one `value.*` per `@setting` (`ERR_DELIVERY_DUPLICATE_SETTING`). An estate
  overlay that overrides a value has to reuse the value node's name so the overlay merges it; a
  second, differently named value for the same setting is an error.
- A model holds at most one deployment per (`@app`, `@environment`), compared as resolved nodes, so
  `Game.server` and `acme::game::Game.server` collide (`ERR_DELIVERY_DUPLICATE_DEPLOYMENT`).

A `value.ref` asks only for an output its producer has (`ERR_DELIVERY_UNSUPPORTED_OUTPUT`): `@path`
extends a URL output only (`url`, `privateUrl`, `publicUrl`); an app produces `host`, `port`,
`privateUrl` and `publicUrl`, and `port` and `privateUrl` need a process that declares `@port`. A
resource's outputs depend on its engine and are left to the platform pack.

A reference fails the load with `ERR_DELIVERY_UNRESOLVED_REF` when it resolves to nothing or to the wrong
kind of node. A platform pack holds its deployments to the same rule by passing
`validateDeployment` as its subtype's validator. `@secrets` (a config pack `vault.*`) and
`@setting` (`Group.field` of an `object.settings`) are names only: this pack does not require the
config pack.

## The estate pattern

The app's repository declares its own deployments. A separate estate repository loads that model,
adds deployments the app never declared (a staging environment), and overrides the ones it did by
overlay, using the loader's existing merge:

```json
{ "metadata.root": { "package": "acme::game", "children": [
  { "deployment.railway": { "name": "server-production", "overlay": true, "@replicas": 2 } }
] } }
```

The `railway` pack's `railway-worked-example` fixture is the whole example, both sides.

### One abstract deployment, one per environment

What is true of every environment (the app, the project, the service, the repository, the values
that do not change) is written once, in an abstract deployment (`"abstract": true`, which is core's
structural keyword, not a new attribute). Each environment's deployment `extends` it and holds only
the differences: its `@environment`, `@branch`, `@domains`, `@replicas` and its own `value.*`
children. A child value that reuses the base value's name overrides it. An abstract deployment may
omit `@app` and `@environment`, a concrete one must resolve both (its own or inherited), and an
abstract one is never counted by the one-deployment-per-(`@app`, `@environment`) check or
deployed. The `railway` pack's `railway-emit-environments` fixture shows it, and
`abstract-deployment-with-environment` is the case where the base also names an environment.

## Readers

`readBuild(app)` and `readProcesses(app)` return an app's build and processes as plain records
(resolving accessors, so an inherited build counts). A platform pack's generator reads through
them.

## Ports

TypeScript only (ADR-0069's port rule: elsewhere a model that uses it fails by name).

## Checks

```
bun scripts/pack-vocabulary.ts delivery
bun scripts/pack-conformance.ts delivery
scripts/ci-local.sh --only packs
```
