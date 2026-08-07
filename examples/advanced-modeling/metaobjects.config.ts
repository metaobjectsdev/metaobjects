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
import { OBJECT_SUBTYPE_VALUE, TYPE_SOURCE, type MetaObject } from "@metaobjectsdev/metadata";

// `entityFile`/`queriesFile` already special-case a pure `object.value` (no
// identity, no source — ADR-0028) as shape-only (interface + Zod, no Drizzle
// table). `routesFile`/`formFile` do not yet make that distinction — they
// assume every entity has a backing table / entity-constants object, which a
// pure VO's `renderValueObjectFile` output doesn't emit. Filtering VOs out of
// these two generators here is the config-level workaround (the `filter`
// option exists for exactly this); it does not belong in this teaching
// example as a code fix. SyllabusSection / InstructorProfile are used only as
// embedded jsonb shapes — neither is independently CRUD-addressable or
// form-submitted, so excluding them is also the semantically correct call for
// this domain. ProgramDescriptionPayload is a SOURCELESS object.projection
// since #210 (assembly origins live on projections; a template payloadRef may
// target a sourceless projection) — it is a wire-assembled payload with no
// backing store, so it is excluded the same way. The one predicate covering
// all three: only a PERSISTED object (a declared/inherited source.* child —
// the #248 persistability contract) is CRUD-addressable or form-submitted.
const isPersisted = (e: MetaObject): boolean =>
  e.children().some((c) => c.type === TYPE_SOURCE) && e.subType !== OBJECT_SUBTYPE_VALUE;

export default defineConfig({
  outDir: "src/generated",
  extStyle: "none",
  dbImport: "../db",
  dialect: "postgres",
  apiPrefix: "/api",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile({ filter: isPersisted }),
    formFile({ filter: isPersisted }),
    promptRender(),
    outputParser(),
    extractor(),
    outputPrompt(),
    renderHelper(),
    barrel(),
  ],
});
