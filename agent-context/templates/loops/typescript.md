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
   / `routesFile()`, docs, `requirementTests()`) is one line too; `npx meta gen --list` is the
   catalog. `npx meta eject <name>` copies one into `codegen/generators/` to change it;
   `npx meta generator new <name>` writes a new one.
2. **Generate.** `npx meta gen`. See a file's exports with `grep -n "^export" <file>`. When
   `agentDocsFile()` / `apiDocsFile()` are wired, read the `agent/*.md` or `api/AGENT-API.md`
   page for the tier you touch.
