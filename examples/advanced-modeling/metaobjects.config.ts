import { defineConfig } from "@metaobjectsdev/cli";
// ADR-0034 scaffold-and-own: entityFile / queriesFile / routesFile / barrel are OWNED
// local copies under codegen/generators/, exactly what `meta init` scaffolds into a real
// consumer project (and what `meta eject <name>` copies on demand). They are the only
// import path for these four as of 1.0 — the deprecated
// `@metaobjectsdev/codegen-ts/generators` export of them was removed at the cut.
import { entityFile } from "./codegen/generators/entity";
import { queriesFile } from "./codegen/generators/queries";
import { routesFile } from "./codegen/generators/routes";
import { barrel } from "./codegen/generators/barrel";
// React form codegen (PATTERN 2 — entity views: the generated form dispatches
// per view.* control, incl. <ImageUpload> for view.image).
import { formFile } from "@metaobjectsdev/codegen-ts-react";
// Template/payload codegen (PATTERN 4 — LLM/document payloads).
import {
  promptRender,
  outputParser,
  extractor,
  outputPrompt,
  renderHelper,
} from "@metaobjectsdev/codegen-ts/generators";
import { TYPE_SOURCE, type MetaObject } from "@metaobjectsdev/metadata";

// `entityFile`/`queriesFile`/`routesFile` derive DB participation from a
// declared/inherited `source.*` child (the #248 persistability contract), so
// the sourceless shapes here need no filter for them: `entityFile` renders a
// sourceless shape as SHAPE-ONLY output (interface + Zod, no Drizzle table —
// see ProgramDescriptionPayload.ts in src/generated/), while `queriesFile`/
// `routesFile` skip it outright. The sourceless shapes: the pure
// `object.value`s (SyllabusSection / InstructorProfile — a value can never
// declare a source, loader-enforced) and the SOURCELESS `object.projection`
// payload (ProgramDescriptionPayload, #210 — assembly origins live on
// projections; a template payloadRef may target a sourceless projection).
// `formFile` is the one generator that does NOT yet make that distinction —
// it assumes every passing entity is form-submittable — so it alone needs the
// config-level `filter` (the option exists for exactly this): only a PERSISTED
// object is form-submitted in this domain.
const isPersisted = (e: MetaObject): boolean =>
  e.children().some((c) => c.type === TYPE_SOURCE);

export default defineConfig({
  outDir: "src/generated",
  extStyle: "none",
  dbImport: "../db",
  dialect: "postgres",
  apiPrefix: "/api",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    formFile({ filter: isPersisted }),
    promptRender(),
    outputParser(),
    extractor(),
    outputPrompt(),
    renderHelper(),
    barrel(),
  ],
});
