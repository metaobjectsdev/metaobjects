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
// CONFIG-GATED, like the api surface. Physical names, the dialect and view dispatch all
// depend on the gen config, so `meta docs` only selects this surface when it has one.
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

import {
  FIELD_SUBTYPE_ENUM,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_ATTR_ORDER_BY,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_ON_DELETE,
  RELATIONSHIP_ATTR_THROUGH,
  TYPE_ORIGIN,
  resolveColumnName,
} from "@metaobjectsdev/metadata";
import type { ColumnNamingStrategy, MetaField, MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, Generator, GeneratorFactory } from "../generator.js";
import { resolveObjectNames } from "../names.js";
import { enumValues, intValueMapOf } from "../enum-meta.js";
import { renderAgentSchemaPage } from "./agent-schema-page.js";
import { renderAgentUiPage } from "./agent-ui-page.js";
import { renderAgentRequirementsPage } from "./agent-requirements-page.js";
import type { AgentSchemaInput } from "./agent-schema-input.js";

/** All three pages live here, under the docs root. */
const DEFAULT_AGENT_DIR = "agent";

export interface AgentDocsFileOpts {
  /** Output prefix for the agent pages. Default `agent`. */
  subDir?: string;
  /** Optional named output target (registry key). */
  target?: string;
  /**
   * The physical schema, with its resolvers injected by whoever owns them. ABSENT is a
   * supported state — `meta docs` runs without a dialect, and a project with no physical
   * schema gets no schema page rather than a page of unknowns.
   */
  schema?: AgentSchemaInput;
  /** The project's column naming strategy, for the field→column mapping. */
  columnNamingStrategy?: ColumnNamingStrategy;
}

/** One `origin.*` child rendered as a lineage phrase. `origin.*` NEVER inherits, so the
 *  own-accessor read here is the correct one rather than an ADR-0039 slip. */
function lineageOf(field: MetaField): string | undefined {
  const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
  if (origin === undefined) return undefined;
  const str = (name: string): string | undefined => {
    const v = origin.attr(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  switch (origin.subType) {
    case ORIGIN_SUBTYPE_PASSTHROUGH: {
      const from = str(ORIGIN_PASSTHROUGH_ATTR_FROM);
      const via = str(ORIGIN_PASSTHROUGH_ATTR_VIA);
      return `passthrough from \`${from ?? "?"}\`${via === undefined ? "" : ` via \`${via}\``}`;
    }
    case ORIGIN_SUBTYPE_AGGREGATE: {
      const agg = str(ORIGIN_AGGREGATE_ATTR_AGG) ?? "?";
      const of = str(ORIGIN_AGGREGATE_ATTR_OF);
      const via = str(ORIGIN_AGGREGATE_ATTR_VIA);
      return `\`${agg}\`${of === undefined ? "" : ` of \`${of}\``}${via === undefined ? "" : ` via \`${via}\``}`;
    }
    case ORIGIN_SUBTYPE_FIRST: {
      const of = str(ORIGIN_AGGREGATE_ATTR_OF);
      const via = str(ORIGIN_AGGREGATE_ATTR_VIA);
      const order = str(ORIGIN_ATTR_ORDER_BY);
      return `first${of === undefined ? "" : ` \`${of}\``}${via === undefined ? "" : ` via \`${via}\``}` +
        `${order === undefined ? "" : ` ordered by \`${order}\``}`;
    }
    case ORIGIN_SUBTYPE_COMPUTED:
      // The @expr tree is structured; naming it is enough to route a reader to the
      // declaration, and rendering a tree into a cell would be a second SQL lowering.
      return "computed from a declared `@expr`";
    default:
      return `\`origin.${origin.subType}\``;
  }
}

/** `- \`Order.lines\` — one-to-many → \`OrderLine\`` */
function relationshipLines(objects: readonly MetaObject[]): string[] {
  const out: string[] = [];
  for (const obj of objects) {
    for (const rel of obj.relationships()) {
      const cardinality = rel.attr(RELATIONSHIP_ATTR_CARDINALITY);
      const target = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF);
      const through = rel.attr(RELATIONSHIP_ATTR_THROUGH);
      const onDelete = rel.attr(RELATIONSHIP_ATTR_ON_DELETE);
      // The FQN, not the short name: this line is an ADDRESS a reader searches for.
      const parts = [`\`${obj.resolutionKey()}.${rel.name}\``, `\`${rel.subType}\``];
      parts.push(
        `${cardinality === "many" ? "one-to-many" : "one-to-one"} → \`${String(target ?? "?")}\``,
      );
      if (typeof through === "string" && through !== "") parts.push(`through \`${through}\` (M:N)`);
      if (typeof onDelete === "string" && onDelete !== "") parts.push(`on delete \`${onDelete}\``);
      out.push(`- ${parts.join(" · ")}`);
    }
  }
  return out;
}

/** `| \`Order.status\` | OPEN, CLOSED | string-backed |` */
function enumLines(objects: readonly MetaObject[]): string[] {
  const rows: string[] = [];
  for (const obj of objects) {
    for (const field of obj.fields()) {
      if (field.subType !== FIELD_SUBTYPE_ENUM) continue;
      const members = enumValues(field);
      if (members === undefined || members.length === 0) continue;
      const intMap = intValueMapOf(field);
      const backing =
        intMap === undefined
          ? "string-backed"
          : `int-backed (${members.map((m) => `${m}=${intMap[m]}`).join(", ")})`;
      rows.push(
        `| \`${obj.resolutionKey()}.${field.name}\` | ${members.map((m) => `\`${m}\``).join(", ")} | ${backing} |`,
      );
    }
  }
  if (rows.length === 0) return [];
  return ["| Field | Members | Storage |", "|---|---|---|", ...rows];
}

export const agentDocsFile = function agentDocsFile(opts?: AgentDocsFileOpts): Generator {
  const dir = (opts?.subDir ?? DEFAULT_AGENT_DIR).replace(/\/$/, "");

  const generator: Generator = {
    name: "agent-docs",
    generate(ctx) {
      const objects = ctx.loadedRoot.objects();
      const files: EmittedFile[] = [];

      // ---- schema.md
      if (opts?.schema !== undefined) {
        // column → declaring field, per qualified table name. `resolveObjectNames` is the
        // ONE field→column resolver — the same one the names artifact and the DDL use —
        // so this mapping cannot disagree with the column it labels.
        const declaredBy = new Map<string, Map<string, { field: string; type: string }>>();
        const viewLineage = new Map<string, string[]>();
        for (const obj of objects) {
          const names = resolveObjectNames(obj, opts.columnNamingStrategy);
          if (names?.name === undefined) continue;
          const key = opts.schema.qualify({ name: names.name, schema: names.schema });
          let map = declaredBy.get(key);
          if (map === undefined) {
            map = new Map();
            declaredBy.set(key, map);
          }
          const lineage: string[] = [];
          for (const field of obj.fields()) {
            const column = resolveColumnName(field, opts.columnNamingStrategy);
            // A TPH base and its subtypes share one table: first writer wins, so the
            // base's own column keeps its label rather than being relabelled by whichever
            // subtype was walked last.
            if (!map.has(column)) {
              map.set(column, { field: field.name, type: `${field.type}.${field.subType}` });
            }
            const line = lineageOf(field);
            if (line !== undefined) lineage.push(`| \`${column}\` | ${line} |`);
          }
          if (lineage.length > 0) viewLineage.set(key, lineage);
        }
        const content = renderAgentSchemaPage(opts.schema, {
          declaredBy,
          viewLineage,
          relationships: relationshipLines(objects),
          enums: enumLines(objects),
        });
        if (content !== "") files.push({ path: `${dir}/schema.md`, content });
      }

      // ---- ui.md
      const ui = renderAgentUiPage(objects);
      if (ui !== "") files.push({ path: `${dir}/ui.md`, content: ui });

      // ---- requirements.md
      const requirements = renderAgentRequirementsPage(ctx.loadedRoot);
      if (requirements !== "") files.push({ path: `${dir}/requirements.md`, content: requirements });

      return files;
    },
  };
  if (opts?.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<AgentDocsFileOpts>;
