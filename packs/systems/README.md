# systems pack

`metaobjects-systems`, version 0.1.0, **preview**, unpublished. An independent pack
([ADR-0069](../../spec/decisions/ADR-0069-independent-packs.md)).

It answers one question: **what exists, and what talks to what?** A system, the apps it is made
of, the resources they use and the outside systems they call. It holds no deploy facts: where an
app runs and what differs per environment is the [`delivery`](../delivery/README.md) pack's. A
documentation explorer can use this pack alone.

## Vocabulary

| Node | What it is | Attributes |
|---|---|---|
| `system.internal` | A system this team builds and runs. Holds `app.*`, `resource.*` and `system.external` | (documentation only) |
| `system.external` | A system someone else runs that an app calls. Inside a system, or at the document root when several share it | (documentation only) |
| `app.service` | A long-running process that answers requests | `@needs`, `@calls`, `@settings` |
| `app.client` | Code that runs on the user's device | the same, plus `@shell` |
| `app.job` | Work that runs to completion | the same, plus `@schedule` (cron, UTC) |
| `resource.database`, `.cache`, `.bucket`, `.keyvalue`, `.queue`, `.volume` | Something an app uses | `@engine`, `@version`, `@managedBy` (`platform` or `external`) |

`app.base`, `resource.base` and `system.base` are abstract anchors and fail to load if authored.
The full definition, with every attribute's description, is [`metamodel/systems.json`](metamodel/systems.json).

## References

Apps and resources are children of a system, so they are addressed the way the loader addresses
any nested node (ADR-0059): `System.child` (`Shop.db`), or `pkg::System.child` from another
package. A bare name means a node of the referrer's own system (of the kind the attribute wants,
when an app and a resource share the name), then a top-level node of that name in the
referrer's package. This bare-name rule is the systems packs' convention, not the loader's.

- `@needs` must name `resource.*` nodes, and `@calls` must name `app.*` or `system.external` nodes.
  A name that resolves to nothing, or to the wrong kind of node, fails the load with
  `ERR_SYSTEMS_UNRESOLVED_REF`. A rename therefore breaks the build rather than going stale.
- `@settings` (an `object.settings` of the config pack) and `@shell` (a UI pack's `nav.shell`) are
  recorded by name only. This pack requires neither pack, so it does not resolve them.

## Example

```json
{ "metadata.root": { "package": "acme::shop", "children": [
  { "system.internal": { "name": "Shop", "children": [
    { "app.service": { "name": "api", "@needs": ["db"], "@calls": ["Payments"], "@settings": ["Database"] } },
    { "resource.database": { "name": "db", "@engine": "postgres", "@version": "18" } },
    { "system.external": { "name": "Payments" } }
  ] } }
] } }
```

## Use it

TypeScript: compose `provider` from `@metaobjectsdev/pack-systems` after the default bundle
(`composeRegistry([...coreProviders, provider])`), or name it in a project's provider list as any
provider of your own ([extending-with-providers](../../docs/features/extending-with-providers.md)).

## Ports

TypeScript only. In every other port the vocabulary is unknown, and a model that uses it fails
there by name (`ERR_UNKNOWN_TYPE`), per ADR-0069's port rule. Keep a systems model in a metadata
collection of its own, read by the Node `meta`, when the application's own port loads its
entities.

## Checks

```
bun scripts/pack-vocabulary.ts systems      # the pinned vocabulary, and that the pack leaves core alone
bun scripts/pack-conformance.ts systems     # fixtures/conformance/ through the TypeScript port
scripts/ci-local.sh --only packs
```
