import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  dialect: "postgres",
  targets: {
    contract: { outDir: "src/generated", runtime: false }, // Zod schemas and types, no ORM
  },
  generators: [entityFile({ target: "contract" })],
});
