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

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)
- [Metamodel reference](https://github.com/metaobjectsdev/metaobjects/blob/main/spec/metamodel.md)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
