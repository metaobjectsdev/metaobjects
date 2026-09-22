import { defineConfig } from "@metaobjectsdev/cli";
// ADR-0034 scaffold-and-own: the four ownable generators are OWNED local copies under
// codegen/generators/, exactly what `meta init` scaffolds into a real consumer project.
// They are the only import path for these four as of 1.0 — the deprecated
// `@metaobjectsdev/codegen-ts/generators` export of them was removed at the cut.
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
// The prompt/render tier has no reference template to eject yet, so it is imported from
// the package. To own one, replace it in `generators` with your own Generator. It
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
    // statement and counterexample in. TypeScript-only; the requirement.*
    // vocabulary and its verify checks are cross-port.
    requirementTests(),
    barrel(),
  ],
});
