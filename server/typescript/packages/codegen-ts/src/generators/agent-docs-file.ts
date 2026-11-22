// agentDocsFile() — the `agent` docs surface.
//
// Three pages under `agent/`, each one an agent reads BEFORE touching a tier:
//
//   • `agent/schema.md`       — before touching persistence
//   • `agent/ui.md`           — before touching a form or a grid
//   • `agent/requirements.md` — before adding a capability
//
// (`api/AGENT-API.md`, the fourth file the always-on pointer names, is the api surface's
// and is emitted by `apiDocsFile()`. It is not duplicated here.)
//
// EVERY PAGE IS DERIVED FROM AN EXISTING BUILDER, and that is the design constraint
// rather than an implementation detail. A documentation surface an agent is told to
// TRUST has to be true, and the only way to keep three more pages true is to give them
// no derivation of their own:
//
//   schema        ← the expected-schema snapshot `meta migrate` diffs and emits from
//                   (injected; see agent-schema-input.ts for why codegen-ts refuses to
//                   compute it) + `resolveObjectNames`, the field→column resolver the
//                   names artifact and the DDL already share
//   ui            ← `buildEntityUiDescriptor`, the same derivation emitted as the
//                   `<Entity>` const that `useEntityForm` reads at runtime
//   requirements  ← `walkRequirements` + `requirementRows`, the same walk the ledger
//                   surface and the generated test stubs are built on
//
// RUN-DEPENDENT, like the api reference. Physical names, the dialect and view dispatch all
// depend on the gen config, which `meta gen` reads before it builds the schema.
// The NEUTRAL model surface stays neutral (ADR-0020); this is a different surface with a
// different contract, not a relaxation of that one.
//
// AN EMPTY PAGE IS NO FILE. Each renderer returns "" when its tier has nothing to
// describe — no physical schema, no UI, no ledger — and an empty render emits nothing.
// That is what makes the surface safe to leave on: a headless project with no ledger sees
// no `agent/` directory rather than three pages of headings.
//
// These files are READ, never imported. There is no three-way merge and no hand-edit
// preservation to think about: regenerate and the page is current.

import { physicalNamingGuideUrl } from "@metaobjectsdev/metadata/release-docs";
import { physicalNamingOf, physicalNamingRemovedMessage } from "@metaobjectsdev/metadata";
import type { EmittedFile, Generator, GeneratorFactory } from "../generator.js";
import { renderAgentSchemaPage } from "./agent-schema-page.js";
import { renderAgentUiPage } from "./agent-ui-page.js";
import { renderAgentRequirementsPage } from "./agent-requirements-page.js";
import type { AgentSchemaInput } from "./agent-schema-input.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";
import { docsTemplateRoot, projectProvider } from "../render-engine/framework-provider.js";

/** All three pages live here, under the docs root. */
const DEFAULT_AGENT_DIR = "agent";

export interface AgentDocsFileOpts {
  /** Output prefix for the agent pages. Default `agent`. */
  subDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /**
   * The physical schema, with its resolvers injected by whoever owns them. Default: the one
   * `meta gen` builds with the project's dialect and column naming (`ctx.docs.agentSchema`).
   * ABSENT both ways is a supported state: a project with no physical schema gets no schema
   * page rather than a page of unknowns.
   */
  schema?: AgentSchemaInput;
  /** Directory whose `templates/agent/{schema,requirements}.md.mustache` (and
   *  `templates/requirements/requirements.md.mustache`, the embedded ledger) override the
   *  shipped pages, relative to the project. Default: the project's own `templates/`. */
  templates?: string;
}

export const agentDocsFile = function agentDocsFile(opts?: AgentDocsFileOpts): Generator {
  // ADR-0058: the column naming is the project's one setting, on the loaded root. A 1.0
  // option is refused rather than dropped: its value may be the one matching the database.
  const removedNaming = (opts as { columnNamingStrategy?: unknown } | undefined)?.columnNamingStrategy;
  if (removedNaming !== undefined) {
    throw new Error(physicalNamingRemovedMessage("the columnNamingStrategy option of agentDocsFile()", String(removedNaming), physicalNamingGuideUrl()));
  }
  const dir = (opts?.subDir ?? DEFAULT_AGENT_DIR).replace(/\/$/, "");

  const generator: Generator = {
    name: "agent-docs",
    target: opts?.target ?? DOCS_TARGET_NAME,
    generate(ctx) {
      const files: EmittedFile[] = [];
      // The schema and requirements pages render shared templates; a same-named template
      // under the project's `templates/` (or under `opts.templates`) replaces one.
      const provider = projectProvider(docsTemplateRoot(ctx, opts?.templates));
      // What the run computes for this generator (docs-run.ts): the schema is built by the
      // caller that owns the schema builder, on first ask. Options win: they are what a
      // direct caller of the factory states.
      const schemaInput = opts?.schema ?? ctx.docs?.agentSchema?.();
      const columnNamingStrategy = ctx.renderContext?.columnNamingStrategy ?? physicalNamingOf(ctx.loadedRoot).columns;

      // ---- schema.md
      // The model walk (column → declaring field, view lineage, relationships, enums) is
      // the page builder's; this passes it the model, the schema and the naming.
      if (schemaInput !== undefined) {
        const content = renderAgentSchemaPage(ctx.loadedRoot, schemaInput, columnNamingStrategy, { provider });
        if (content !== "") files.push({ path: `${dir}/schema.md`, content });
      }

      // ---- ui.md
      // Gated on the RUN, not on the metadata. `hasUiSurface` answers "could a UI be
      // generated for this object?"; whether one IS generated is a generator fact that
      // no metadata predicate can reach. A project with `generators: []` was handed a
      // page asserting endpoints nothing serves and a control table for forms that do
      // not exist — to an audience the agent surface explicitly tells to read it BEFORE
      // touching a tier, which is the audience least able to check.
      //
      // The apiPrefix is the project's, from the render context the runner built — the
      // same value `routes-file.ts` emits as the SERVER mount prefix. Without it the page
      // names an address nothing serves. (The client descriptor no longer carries it: a
      // browser's base URL is supplied at runtime by the provider's `baseUrl`.)
      {
        const ui = renderAgentUiPage(ctx.loadedRoot, ctx.renderContext?.apiPrefix ?? "");
        if (ui !== "") {
          if (ctx.config.includeUiTier === true) {
            files.push({ path: `${dir}/ui.md`, content: ui });
          } else if (ctx.config.includeUiTierExplicit !== true) {
            // The model HAS a UI surface (renderAgentUiPage returned content) but this
            // run has no client UI generator and the config left `includeUiTier` unset, so
            // the page is skipped. Before this, that was silent: `meta gen` exited 0 and
            // listed only the pages it wrote, and a docs-only project (its own config
            // generates no UI; a SEPARATE config does) lost `agent/ui.md` with no signal at
            // all. An explicit `includeUiTier: false` says there is no UI anywhere, so a
            // server-only project has a way to say so and is not advised on every run.
            ctx.warn(
              `${dir}/ui.md not written: no client UI generator in this run; set includeUiTier: true if another config generates the UI, or includeUiTier: false if there is no UI.`,
            );
          }
        }
      }

      // ---- requirements.md
      const requirements = renderAgentRequirementsPage(ctx.loadedRoot, ctx.inLedger, provider);
      if (requirements !== "") files.push({ path: `${dir}/requirements.md`, content: requirements });

      return files;
    },
  };
  return generator;
} as GeneratorFactory<AgentDocsFileOpts>;
