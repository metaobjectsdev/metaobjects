import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "src/generated",
  // The modules sit in one directory, which this example's own code imports from; the
  // package layout would put them in a directory per package.
  outputLayout: "flat",
  dialect: "postgres",
  targets: {
    contract: { outDir: "src/generated", runtime: false }, // Zod schemas and types, no ORM
  },
  generators: [entityFile({ target: "contract" })],
});
