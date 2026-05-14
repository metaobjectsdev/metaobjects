
import { defineConfig } from "@metaobjects/codegen-ts";
import { entityFile } from "@metaobjects/codegen-ts/generators";
export default defineConfig({
  outDir: "./src/db",
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
