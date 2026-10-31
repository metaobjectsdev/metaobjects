import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "api/src/generated",
  dialect: "postgres",
  generators: [entityFile()],
});
