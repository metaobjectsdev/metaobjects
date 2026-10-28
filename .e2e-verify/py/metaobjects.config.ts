import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: "./generated/db",
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
