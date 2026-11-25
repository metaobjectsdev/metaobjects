# railway pack

`metaobjects-railway`, version 0.1.0, **preview**, unpublished. An independent pack
([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)). Requires
[`delivery`](../delivery/README.md).

Railway as a deployment platform. **Vocabulary only so far:** it registers `deployment.railway`,
so a model can place an app on Railway and be checked. The generators (the `.railway/railway.ts`
file, the list of facts that file cannot hold, the secret sync, deploy and doctor scripts) are
later work in this pack.

## Vocabulary

| Node | Attributes |
|---|---|
| `deployment.railway` | every `deployment.base` attribute (`@app`, `@environment`, `@domains`, `@replicas`, `@region`, `@branch`, `@secrets`, and `value.*` children), plus `@project` (required) and `@service` (absent: the app's name) |

A `deployment.railway` is held to the delivery pack's references: `@app` must name an `app.*`,
`@environment` an `environment.*` (`ERR_DELIVERY_UNRESOLVED_REF`).

## The worked example

[`fixtures/conformance/railway-worked-example/`](fixtures/conformance/railway-worked-example/) is
an app's systems model (one service with its build and process facts, a database, a cache, an
outside bucket, two outside systems, a production deployment with a database URL by reference and a
literal profile) and an estate repository's additions (a staging environment and deployment it
declares itself, and an overlay that runs production on two replicas). Names, domains and project
names are placeholders.

## Ports

TypeScript only.
