import { defineConfig } from "@metaobjectsdev/cli";
// This example is embedded IN the metaobjects monorepo (not `npm install`ed),
// so there is no scaffolded ADR-0034 owned-copy target for it to import from
// (`meta init`'s codegen/generators/*.ts copies resolve their OWN imports via
// a real package install, which this repo-local example doesn't have). A real
// consumer project runs `meta init` and gets local, editable owned copies —
// see CLAUDE.md "Codegen architecture (Vite-style plugins)". Here every
// generator is imported directly from the package.
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
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
