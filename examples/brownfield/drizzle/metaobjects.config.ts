import { defineConfig } from "@metaobjectsdev/cli";

export default defineConfig({
  outDir: "src/generated", // beside the existing code; nothing imports it yet
  dialect: "postgres",
  timestampMode: "date", // the existing timestamp columns read as Date
  generators: ["entity"],
});
