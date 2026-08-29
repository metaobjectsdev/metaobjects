import { defineConfig } from "@metaobjectsdev/cli";
// This example is embedded IN the metaobjects monorepo (not `npm install`ed), so
// there is no scaffolded ADR-0034 owned-copy target for it to import from — every
// generator is imported directly from the package. A real consumer project runs
// `meta init` and gets local, editable owned copies.
import {
  entityFile,
  queriesFile,
  routesFile,
  barrel,
  promptRender,
  renderHelper,
  requirementTests,
} from "@metaobjectsdev/codegen-ts/generators";

export default defineConfig({
  outDir: "generated/ts",
  extStyle: "none",
  dbImport: "../db",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    // The prompt tier: subscriberBlurb declares no @responseRef, so it generates a
    // render + payload record and NOTHING that reads a model's reply (ADR-0052).
    promptRender(),
    renderHelper(),
    // The fifth pillar's own evidence — a test stub per claim, carrying the
    // statement and counterexample in. TypeScript-only; the requirement.*
    // vocabulary and its verify checks are cross-port.
    requirementTests(),
    barrel(),
  ],
});
