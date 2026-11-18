import { defineConfig } from "@metaobjectsdev/cli";

export default defineConfig({
  outDir: "src/generated", // beside the existing code; nothing imports it yet
  // The modules sit in one directory, which this example's own code imports from; the
  // package layout would put them in a directory per package.
  outputLayout: "flat",
  dialect: "postgres",
  timestampMode: "date", // the existing timestamp columns read as Date
  generators: ["entity"],
});
