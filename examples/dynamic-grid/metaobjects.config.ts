import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, namesFile } from "@metaobjectsdev/codegen-ts/generators";

// The ONLY generated code in this example: what hand-written business logic is typed
// against. `runtime: false` makes the target contract-only: TypeScript types and Zod
// schemas, with no Drizzle table and no route, hook, grid or form. `namesFile()` adds the
// name constants. Everything a user sees is rendered from the loaded metadata instead
// (src/client/), and every route is served from it (src/server/routes.ts).
export default defineConfig({
  outDir: "src/generated",
  outputLayout: "flat",
  extStyle: "none",
  dialect: "sqlite",
  targets: {
    default: { outDir: "src/generated", outputLayout: "flat", runtime: false },
  },
  generators: [entityFile(), namesFile()],
});
