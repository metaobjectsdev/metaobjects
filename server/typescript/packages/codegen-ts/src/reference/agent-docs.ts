// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/agent-docs.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { agentDocsFile } from "./codegen/generators/agent-docs.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown. The pages are read by a coding agent, never imported.
// use-when:      you want to change the pages written for a coding agent: which of the three
//                are written, where they land, or what the schema page says about your
//                tables. The packaged `agentDocsFile()` writes them without this file; eject
//                it only to change them.
// emits:         into the `docs` target, in `agent/` (or `subDir`): schema.md, read before
//                touching persistence; ui.md, read before touching a form or a grid;
//                requirements.md, read before adding a capability. A tier with nothing to
//                describe emits no file.
// customize:     which of the three pages are written and where (`generate`), and the
//                `templates` option, which swaps the mustache templates the pages render
//                through. The model walk (`modelFacts`, `lineageOf`, `relationshipLines`,
//                `enumRows`) lives in `agent-schema-page`; the page renderers
//                (`agent-schema-page`, `agent-ui-page`, `agent-requirements-page`) are
//                copied beside this file into codegen/templates/ by `meta eject`.
// composes-with: api-docs (the fourth file the always-on pointer names, `api/AGENT-API.md`,
//                is the api reference's, not this one's).
//
// HOW IT RUNS. Like every generator: list it in `generators` in metaobjects.config.ts, with
// a `docs` target declared, and `meta gen` writes the pages (`meta verify --codegen` checks
// them). `meta gen` builds the physical schema (it needs the project's dialect and column
// naming, `naming` in .metaobjects/config.json) and hands it over on `ctx.docs.agentSchema`;
// pass `schema` as an option to state it yourself instead.
//
// Everything below imports the engine from `@metaobjectsdev/codegen-ts`, the node types from
// `@metaobjectsdev/metadata`, and the page renderers from `../generators/` — which
// `meta eject` copies into your project and points at your copy.
//
// Three pages under `agent/`, each one an agent reads BEFORE touching a tier:
//
//   • `agent/schema.md`       — before touching persistence
//   • `agent/ui.md`           — before touching a form or a grid
//   • `agent/requirements.md` — before adding a capability
//
// EVERY PAGE IS DERIVED FROM AN EXISTING BUILDER: an agent is told to TRUST these pages, so
// each is built from what the toolchain itself reads rather than from a derivation of its
// own. An empty page is no file.

import { physicalNamingGuideUrl } from "@metaobjectsdev/metadata/release-docs";
import { physicalNamingOf, physicalNamingRemovedMessage } from "@metaobjectsdev/metadata";
import {
  docsTemplateRoot,
  projectProvider,
  type AgentSchemaInput,
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  DOCS_TARGET_NAME,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderAgentSchemaPage } from "../generators/agent-schema-page.js";
import { renderAgentUiPage } from "../generators/agent-ui-page.js";
import { renderAgentRequirementsPage } from "../generators/agent-requirements-page.js";

/** All three pages live here, under the docs root. */
const DEFAULT_AGENT_DIR = "agent";

export interface AgentDocsFileOpts {
  /** Output prefix for the agent pages. Default `agent`. */
  subDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /**
   * The physical schema, with its resolvers injected by whoever owns them. Default: the one
   * `meta gen` builds (`ctx.docs.agentSchema`). ABSENT both ways is a supported state: a
   * project with no physical schema gets no schema page rather than a page of unknowns.
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
      // What the run computes for this generator: the schema, built on first ask by the
      // caller that owns the schema builder, and the project's column naming. Options win:
      // they are what a direct caller of the factory states.
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
