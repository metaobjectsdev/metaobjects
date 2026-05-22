# @metaobjectsdev/sdk

Programmatic SDK for MetaObjects: workspace memory records, path resolution, project config loading, and the agent-docs reference content. Consumed by the `meta` CLI and by AI-collaboration tooling (MCP exposers, codegen prompts).

## Install

```bash
pnpm add @metaobjectsdev/sdk
```

## Usage

```ts
import { resolveMetaRoot, loadConfig } from "@metaobjectsdev/sdk";

const metaRoot = await resolveMetaRoot(process.cwd());
const config = await loadConfig(metaRoot);
```

The canonical agent reference docs (scaffolded by `meta init`) are available via a sub-path:

```ts
import { AGENT_DOCS_BODY, withContentHash } from "@metaobjectsdev/sdk/agent-docs";
```

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
