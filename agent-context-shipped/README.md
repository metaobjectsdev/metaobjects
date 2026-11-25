# The shipped agent files

The always-on `.metaobjects/AGENTS.md` and the `metaobjects-*` skills, assembled once at build
time for every stack a port's own `agent-docs` command serves. Every non-TypeScript port embeds
this directory in its package and copies one stack out of it, so a project gets its agent files
with no Node on the path ([ADR-0033](../spec/decisions/ADR-0033-single-agent-context-assembler.md),
Amendment 1).

Everything here but this README is built. Do not edit it by hand: change `agent-context/` and
rebuild.

```bash
bun server/typescript/packages/sdk/scripts/build-shipped-agent-context.ts           # rebuild
bun server/typescript/packages/sdk/scripts/build-shipped-agent-context.ts --check   # exit 1 when stale
```

`server/typescript/packages/sdk/test/agent-context/shipped.test.ts` fails when the tree is stale.

## Layout

```
manifest.json          the stacks, and the files each one writes
files/<hash>.md        each distinct file once, named by its content hash
```

`manifest.json`:

| Key | Meaning |
|---|---|
| `schema` | The manifest's shape, `2`. Refuse a manifest whose schema you do not know. |
| `docsRef` | The git ref every guide link in the files is pinned to (`main`). |
| `docsLinkPrefix` | What comes before the ref in a guide link: the repository's `.../blob/`. |
| `skillsDir` | The directory every skill's path starts with (`.claude/skills`). |
| `stacks` | One entry per stack: `id`, `servers`, `clients`, `migration`, and `files`, each a `path` (relative to the project root) and the `file` under `files/` it copies. |

The stacks are every server language alone (`typescript`, `java`, `kotlin`, `csharp`, `python`,
`rust`) and Java with Kotlin together (one Maven goal serves both), each with every client
choice: none, `react`, `react` with `tanstack`, and `angular`. Each of those is shipped twice:
without and with the reference migration helper's steps (`migration: true`), which the
always-on file carries only for a project that chose a `meta migrate` dialect.

## What a port's command does

1. **Find the stack.** Its id is the server languages, then the clients, each in this order and
   joined by `-`: servers `typescript, java, kotlin, csharp, python, rust`; clients
   `react, tanstack, angular`. So `--server kotlin --server java --client tanstack --client react`
   is `java-kotlin-react-tanstack`. When the project's `.metaobjects/config.json` sets
   `migrate.dialect`, append `-migrate`: `java-kotlin-react-tanstack-migrate`. Refuse a stack
   with no entry, and name the ids that exist.
2. **Pin the links.** In every file, replace each `docsLinkPrefix + docsRef + "/"` with
   `docsLinkPrefix + <ref> + "/"`, where `<ref>` is the release tag: `v` and the release's
   npm-line version, so 1.3.0 is `v1.3.0` (Maven's 8.3.0 is also `v1.3.0`: its major is the npm
   major plus 7). A prerelease, or a version the port cannot resolve, has no tag and keeps
   `main`, so its files are written unchanged. That is a plain text replacement, with nothing
   else to know (`docsRefForVersion` and `pinDocsRefs` in `@metaobjectsdev/metadata` are the
   reference).
3. **Write each file** at its `path` under the project root, and nothing else.

The result is byte-identical to what `npx meta agent-docs` writes for the same stack, which
`shipped.test.ts` checks for every stack here.
