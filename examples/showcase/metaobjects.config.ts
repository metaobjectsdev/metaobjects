import { defineConfig } from "@metaobjectsdev/cli";
// ADR-0034 scaffold-and-own: this example OWNS its four core generators, as local copies
// under codegen/generators/ — what `meta eject entity queries routes barrel` writes. That
// is the customization path. Importing the same four from
// `@metaobjectsdev/codegen-ts/generators` runs them as shipped and works too (removed at
// 1.0, restored in 1.1 — ADR-0034 Amendment 5).
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
// The prompt/render tier is imported from the package and run as shipped. To own one,
// `meta eject prompt-render` (or any of the others) and import the local copy. It
// references the value-object types entityFile() emits (ADR-0056), so it needs
// entityFile() in the same run.
import {
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
    // statement and counterexample in. The hand-filled stub is TypeScript's form;
    // the other ports generate tests that call a witness you own. The
    // requirement.* vocabulary and its verify checks are cross-port.
    requirementTests(),
    barrel(),
  ],
});
