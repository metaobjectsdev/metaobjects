import { defineConfig } from "@metaobjectsdev/cli";
import { rustCli } from "./codegen/generators/rust-cli.js";

export default defineConfig({ outDir: "crates/tasks-axi-gen", generators: [rustCli()] });
