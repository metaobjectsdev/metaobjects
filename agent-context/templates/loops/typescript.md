### TypeScript: generate with `npx meta gen`

1. **Config.** In `metaobjects.config.ts` set `dialect` (`"postgres" | "sqlite" | "mysql"`; D1 is
   `"sqlite"`) and list the generators. Nothing is generated until it is listed. The usual data
   layer:

   ```ts
   import { entityFile, namesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
   // generators: [entityFile(), namesFile(), barrel()]
   ```

   Per entity: `<Entity>.ts` (Drizzle table, row types, Zod schemas, enum types) and
   `<Entity>.names.ts` (physical names), plus an `index.ts` barrel. Install what they import:
   `npm i drizzle-orm zod` and your database driver. Every other generator (CRUD `queriesFile()`
   / `routesFile()`, docs, `requirementTests()` for a test stub per requirement) is one line too:

   ```
   npx meta gen --list --probe 2>/dev/null | grep -E "^  - name|wouldEmit|      import:" | paste - - -
   ```

   `npx meta eject <name>` copies one into `codegen/generators/` to change it;
   `npx meta generator new <name>` writes a new one.
2. **Generate.** `npx meta gen`. See a file's exports with `grep -n "^export" <file>`.
3. **Reference pages.** `agentDocsFile()` and `apiDocsFile()` with `targets: { docs: { outDir:
   "docs" } }` write `agent/schema.md`, `agent/ui.md`, `agent/requirements.md` and
   `api/AGENT-API.md`. When they exist, read the one for the tier you touch.
