# @metaobjectsdev/metadata

The metamodel loader, typed views, and constants for the MetaObjects standard. This is the foundation package every other `@metaobjectsdev/*` package builds on — it parses `metaobjects/*.json` files into a typed object model, resolves `extends` and overlay merging, and exposes the 11-type vocabulary as named constants.

## Install

```bash
pnpm add @metaobjectsdev/metadata
```

## Usage

```ts
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const json = `{ "metadata.root": { "package": "demo", "children": [] } }`;
const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
```

The public loader API is `MetaDataLoader` + `InMemoryStringSource`. A `MetaDataLoader` instance is single-use; construct a new one per load.

## Loader errors (FR5a)

Every loader error conforms to the cross-port `LoaderError` envelope
(ADR-0009):

```ts
interface LoaderError {
  code: string;            // ERR_UNKNOWN_TYPE, ERR_BAD_ATTR_VALUE, ...
  message: string;
  source: ErrorSource;     // always populated
}

type ErrorSource =
  | { format: "json"; files: [string]; jsonPath: string }
  | { format: "yaml"; files: [string]; jsonPath: string; yamlPosition?: { line: number; col: number } }
  | { format: "merged"; files: string[]; jsonPath: string; contributors: Contributor[] }
  | { format: "resolved"; files: string[]; jsonPath?: string; referrer?: string; target?: string }
  | { format: "database"; dbLocation: { table: string; id: string }; jsonPath?: string }
  | { format: "code"; caller?: string };
```

Every `MetaData` node also carries a populated `source` field, so
post-load consumers (drift detection, MCP, debug tools) can answer
"where did this node come from?" without an extra lookup table.

`LoadResult.warnings` is a parallel `LoaderWarning[]` channel — same
envelope shape, `WARN_*` prefixed codes. Pre-FR5a string warnings are
wrapped at the loader boundary as `WARN_LEGACY` envelopes; FR5c will
retire the legacy code by routing each emit site through a proper
envelope-shaped helper.

The package re-exports the envelope types and the `codeSource()`
helper for consumers that catch + repackage `ParseError`s or build
synthetic envelopes for programmatic-construction tests:

```ts
import type {
  ErrorSource,
  LoaderError,
  LoaderWarning,
  NodeContext,
  Contributor,
} from "@metaobjectsdev/metadata";
import { codeSource } from "@metaobjectsdev/metadata";
```

See [ADR-0009](../../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md)
for the full schema and the FR5 family for the per-error-class
rollout plan (5a JSON shape, 5b YAML positions, 5c multi-file merge
attribution, 5d reference resolution, 5e database sources).

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)
- [Metamodel reference](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/metamodel.md)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
