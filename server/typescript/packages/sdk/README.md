# @metaobjectsdev/sdk

Programmatic SDK for MetaObjects: project/collection resolution, metadata loading, and project config loading. Consumed by the `meta` CLI and by AI-collaboration tooling (MCP exposers, codegen prompts).

## Install

```bash
pnpm add @metaobjectsdev/sdk
```

## Usage

```ts
import { resolveCollection, loadMemory } from "@metaobjectsdev/sdk";

// `resolveCollection` is the single authority for "which project is this, and which
// metadata files does it declare?" — it discovers the project root, reads its
// `.metaobjects/config.json` if there is one, and resolves the declared `sources`.
const collection = await resolveCollection(process.cwd());
const root = await loadMemory(collection.configDir, { files: collection.files });
```

## agent-context

`@metaobjectsdev/sdk/agent-context` assembles the downstream AI-assistant context
(the slim `.metaobjects/AGENTS.md`/`CLAUDE.md` + the six `metaobjects-*` Claude
skills with only the project's language reference fragments) from the repo-root
`agent-context/` source tree. `makeStack`/`detectStack` resolve the project's
server+client axes; `assemble({ contentRoot, stack })` emits the files. Design:
`docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.

## Links

- [Spec](https://github.com/metaobjectsdev/metaobjects/tree/main/spec)

## License

Apache 2.0 — see [LICENSE](../../../../LICENSE) at the repo root.
