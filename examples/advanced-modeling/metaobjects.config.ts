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
import { OBJECT_SUBTYPE_VALUE, type MetaObject } from "@metaobjectsdev/metadata";

// `entityFile`/`queriesFile` already special-case a pure `object.value` (no
// identity, no source — ADR-0028) as shape-only (interface + Zod, no Drizzle
// table). `routesFile`/`formFile` do not yet make that distinction — they
// assume every entity has a backing table / entity-constants object, which a
// pure VO's `renderValueObjectFile` output doesn't emit. Filtering VOs out of
// these two generators here is the config-level workaround (the `filter`
// option exists for exactly this); it does not belong in this teaching
// example as a code fix. SyllabusSection / InstructorProfile /
// ProgramDescriptionPayload are used only as embedded jsonb shapes / a
// payload — none is independently CRUD-addressable or form-submitted, so
// excluding them is also the semantically correct call for this domain.
const isNotValueObject = (e: MetaObject): boolean => e.subType !== OBJECT_SUBTYPE_VALUE;

export default defineConfig({
  outDir: "src/generated",
  extStyle: "none",
  dbImport: "../db",
  dialect: "postgres",
  apiPrefix: "/api",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile({ filter: isNotValueObject }),
    formFile({ filter: isNotValueObject }),
    promptRender(),
    outputParser(),
    extractor(),
    outputPrompt(),
    renderHelper(),
    barrel(),
  ],
});
