import { call, str, TsWriter } from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject } from "@metaobjectsdev/metadata";
import type { RenderContext, RelationEntry } from "@metaobjectsdev/codegen-ts/engine";

import {
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  isProjection,
  hasItemRoute,
  hookListNameSegment,
  entityModuleSpecifier,
  effectivePackage,
  siblingSpecifier,
} from "@metaobjectsdev/codegen-ts/engine";
import { getPkInfo } from "@metaobjectsdev/codegen-ts/engine";
import {
  isTphDiscriminatorBase,
  tphPlan,
} from "@metaobjectsdev/codegen-ts/templates/tph-discriminator";

const TANSTACK_QUERY = "@tanstack/react-query";
const METAOBJECTS_TANSTACK = "@metaobjectsdev/tanstack";
const RUNTIME_WEB = "@metaobjectsdev/runtime-web";

/** The DB-free `<Entity>.meta` descriptor. The UI generator writes it into ITS OWN target,
 *  beside this file, so it is always a sibling import — never the entity module's path,
 *  which on a multi-target project is another package's importBase. The UI files take the
 *  `<Entity>` descriptor from there so a browser bundle never pulls the Drizzle table in —
 *  it is the ONLY value they import from the entity module; everything else is `import type`. */
function metaModuleOf(entity: MetaObject, ctx: RenderContext): string {
  return siblingSpecifier(ctx.selfTarget, effectivePackage(entity), `${entity.name}.meta`, ctx.extStyle);
}

/** A template literal: `` `text` ``. */
const template = (text: string): string => `\`${text}\``;
/** A substitution inside a template literal: `${expr}`. */
const sub = (expr: string): string => `\${${expr}}`;

/**
 * Render <Entity>.hooks.ts — query-key factory + 2 query hooks + (for non-projections) 3 mutation hooks.
 *
 * Projections (view-backed, read-only) emit only:
 *   - <camel>Keys query-key factory
 *   - use<Entity>(id)       — useQuery on GET :id (only when the projection has an id
 *                             column; a keyless one has no item route to fetch)
 *   - use<Entities>(filter) — useQuery on list
 *
 * Full (writable) entities additionally emit:
 *   - useCreate<Entity>
 *   - useUpdate<Entity>
 *   - useDelete<Entity>
 *
 * All hooks call useEntityPathFetcher() (from @metaobjectsdev/tanstack) for
 * the underlying HTTP. Mutations aggressively invalidate <entity>Keys.all().
 */
export function renderHooksFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeHooksFile(w, entity, ctx);
  return w.toString();
}

/** Write <Entity>.hooks.ts (header, imports and every hook) into `w`. */
export function writeHooksFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entity.name,
    ctx.extStyle,
  );
  // FR-017 Tier 3: a TPH discriminator base gets a polymorphic + per-subtype
  // hooks file (the subtype entities are filtered out of this generator).
  if (isTphDiscriminatorBase(entity, ctx.loadedRoot)) {
    writeTphHooksFile(w, entity, ctx, entityModule);
  } else if (isProjection(entity)) {
    writeReadOnlyHooksFile(w, entity, entityModule, ctx);
  } else {
    writeFullHooksFile(w, entity, entityModule, ctx);
  }
}

// ---------------------------------------------------------------------------
// The two hook shapes every path below is built from.
// ---------------------------------------------------------------------------

/** `export function <name>(<params>): <returns> {`, the body, `}`, after a blank line. */
function writeHookFn(w: TsWriter, name: string, params: readonly string[], returns: string, body: () => void): void {
  w.blank();
  w.block([call(`export function ${name}`, params), `: ${returns} {`], body);
}

interface QueryHook {
  name: string;
  /** The leading parameter: `id: number`, `filter?: XFilter`, `sourceId: string | undefined`. */
  param: string;
  /** The type the query resolves to. */
  data: string;
  queryKey: string;
  /** The fetched URL, a template literal. */
  url: string;
  /** Whether `filter` is serialized into a `qs` query string first. */
  filterQs?: boolean;
  enabled?: string;
}

/** A useQuery hook over one GET. */
function writeQueryHook(w: TsWriter, h: QueryHook): void {
  const options = w.useType("UseQueryOptions", TANSTACK_QUERY);
  const result = w.useType("UseQueryResult", TANSTACK_QUERY);
  const opts = `opts?: Omit<${options}<${h.data}>, "queryKey" | "queryFn">`;
  writeHookFn(w, h.name, [h.param, opts], `${result}<${h.data}>`, () => {
    w.line(`const fetcher = ${w.use("useEntityPathFetcher", METAOBJECTS_TANSTACK)}();`);
    if (h.filterQs) {
      w.line(`const qs = filter ? "?" + ${w.use("buildFilterQs", RUNTIME_WEB)}(filter as Record<string, unknown>) : "";`);
    }
    w.block(`return ${w.use("useQuery", TANSTACK_QUERY)}<${h.data}>({`, () => {
      w.line(`queryKey: ${h.queryKey},`);
      w.line(`queryFn: () => fetcher<${h.data}>(${h.url}),`);
      if (h.enabled !== undefined) w.line(`enabled: ${h.enabled},`);
      w.line("...opts,");
    }, "});");
  });
}

interface MutationHook {
  name: string;
  data: string;
  /** The mutation's variables type. */
  vars: string;
  /** Whether `useMutation` is called with its type arguments spelled out. */
  typed: boolean;
  /** The mutationFn's parameter list: `(input)`, `({ id, input })`, `(id)`. */
  params: string;
  url: string;
  /** `POST`/`PATCH` send the variables' `input` as a JSON body; `DELETE` sends none. */
  method: "POST" | "PATCH" | "DELETE";
  keysVar: string;
}

/** A useMutation hook over one write, invalidating every query of the entity on success. */
function writeMutationHook(w: TsWriter, h: MutationHook): void {
  const typeArgs = `${h.data}, Error, ${h.vars}`;
  const options = w.useType("UseMutationOptions", TANSTACK_QUERY);
  const result = w.useType("UseMutationResult", TANSTACK_QUERY);
  writeHookFn(w, h.name, [`opts?: Omit<${options}<${typeArgs}>, "mutationFn">`], `${result}<${typeArgs}>`, () => {
    w.line(`const fetcher = ${w.use("useEntityPathFetcher", METAOBJECTS_TANSTACK)}();`);
    w.line(`const qc = ${w.use("useQueryClient", TANSTACK_QUERY)}();`);
    const mutation = w.use("useMutation", TANSTACK_QUERY);
    w.block(`return ${mutation}${h.typed ? `<${typeArgs}>` : ""}({`, () => {
      if (h.method === "DELETE") {
        w.line(`mutationFn: ${h.params} => fetcher<${h.data}>(${h.url}, { method: "DELETE" }),`);
      } else {
        w.block(`mutationFn: ${h.params} => fetcher<${h.data}>(${h.url}, {`, () => {
          w.line(`method: ${str(h.method)},`);
          w.line(`headers: { "Content-Type": "application/json" },`);
          w.line("body: JSON.stringify(input),");
        }, "}),");
      }
      w.line("...opts,");
      w.block("onSuccess: (...args) => {", () => {
        w.line(`qc.invalidateQueries({ queryKey: ${h.keysVar}.all() });`);
        w.line("opts?.onSuccess?.(...args);");
      }, "},");
    }, "});");
  });
}

/** useCreate / useUpdate / useDelete for one writable REST collection. */
function writeCrudMutations(
  w: TsWriter,
  m: { name: string; row: string; createInput: string; updateInput: string; pkType: string; path: string; keysVar: string },
): void {
  writeMutationHook(w, {
    name: `useCreate${m.name}`,
    data: m.row,
    vars: m.createInput,
    typed: true,
    params: "(input)",
    url: template(m.path),
    method: "POST",
    keysVar: m.keysVar,
  });
  writeMutationHook(w, {
    name: `useUpdate${m.name}`,
    data: m.row,
    vars: `{ id: ${m.pkType}; input: ${m.updateInput} }`,
    typed: false,
    params: "({ id, input })",
    url: template(`${m.path}/${sub("id")}`),
    method: "PATCH",
    keysVar: m.keysVar,
  });
  writeMutationHook(w, {
    name: `useDelete${m.name}`,
    data: "void",
    vars: m.pkType,
    typed: false,
    params: "(id)",
    url: template(`${m.path}/${sub("id")}`),
    method: "DELETE",
    keysVar: m.keysVar,
  });
}

/** The detail and list hooks of one REST collection. */
function writeDetailHook(w: TsWriter, name: string, row: string, pkType: string, path: string, queryKey: string): void {
  writeQueryHook(w, {
    name,
    param: `id: ${pkType}`,
    data: row,
    queryKey,
    url: template(`${path}/${sub("id")}`),
  });
}

function writeListHook(w: TsWriter, name: string, row: string, filterType: string, path: string, queryKey: string): void {
  writeQueryHook(w, {
    name,
    param: `filter?: ${filterType}`,
    data: `${row}[]`,
    queryKey,
    url: template(`${path}${sub("qs")}`),
    filterQs: true,
  });
}

// ---------------------------------------------------------------------------
// FR-018 — M:N collection hook(s).
//
// For each many-to-many relationship the source declares (`@cardinality: "many"`
// + `@through`), emit `use<Source><Relation>(sourceId, opts?)` — a useQuery that
// fetches the REST sub-resource `GET /<source-plural>/{sourceId}/<relationName>`
// (the exact URL mountM2mRoute serves) and returns the typed target collection
// (`Target[]`). The query is enabled only when sourceId is present, so callers
// can pass `undefined` before the parent row loads. A symmetric self-join is
// still ONE collection hook (the server unions both junction columns on read).
// ---------------------------------------------------------------------------

/** The M:N relation entries for an entity (cardinality 'many' + a junction). */
function m2mEntriesFor(entity: MetaObject, ctx: RenderContext): RelationEntry[] {
  return (ctx.relationMap.get(entity.name) ?? []).filter(
    (e) => e.cardinality === "many" && e.junctionEntity !== undefined,
  );
}

/** The `relation: (relation, sourceId) => ...` query-key factory member, written into the keys
 *  factory ONLY when the entity has M:N relationships. */
function writeM2mKey(w: TsWriter, keysVar: string, pkType: string): void {
  w.line(`relation: (relation: string, sourceId: ${pkType} | undefined) => [...${keysVar}.all(), "relation", relation, sourceId ?? null] as const,`);
}

/** `use<Source><Relation>(sourceId, opts?)` per M:N relationship; nothing when there are none. */
function writeM2mHooks(w: TsWriter, entity: MetaObject, ctx: RenderContext, keysVar: string, entries: RelationEntry[]): void {
  // sourceId IS this entity's PK — it is interpolated straight into
  // `GET /<source-plural>/{sourceId}/<relation>`, so it must carry the declared PK type.
  const pkType = getPkInfo(entity, ctx).tsType;
  const source = entity.name;
  for (const e of entries) {
    const mod = entityModuleSpecifier(
      ctx.selfTarget,
      ctx.entityModuleTarget,
      effectivePackage(e.target),
      e.targetEntity,
      ctx.extStyle,
    );
    // `import { type <Target> as <Target>RelRow } from "<mod>"` — the RelRow
    // alias avoids colliding with the source file's own `type <Source> as
    // <Source>Row` import on a self-join (source === target).
    const target = w.useType(e.targetEntity, mod, `${e.targetEntity}RelRow`);
    writeQueryHook(w, {
      name: `use${source}${capitalize(e.name)}`,
      param: `sourceId: ${pkType} | undefined`,
      data: `${target}[]`,
      queryKey: `${keysVar}.relation(${str(e.name)}, sourceId)`,
      url: template(`${sub(`${source}.$path`)}/${sub("sourceId")}/${e.name}`),
      enabled: "sourceId != null && (opts?.enabled ?? true)",
    });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function writeHeader(w: TsWriter, entity: MetaObject, note?: string): void {
  w.header(
    `// ${GENERATED_HEADER}-tanstack — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entity.name} (${entity.fqn()})${note === undefined ? "" : ` — ${note}`}`,
  );
}

/** The `all`, `lists` and `list` members every keys factory starts with. */
function writeListKeys(w: TsWriter, keysVar: string, lcEntity: string, filterType: string): void {
  w.line(`all: () => [${str(lcEntity)}] as const,`);
  w.line(`lists: () => [...${keysVar}.all(), "list"] as const,`);
  w.line(`list: (filter?: ${filterType}) => [...${keysVar}.lists(), filter ?? {}] as const,`);
}

function writeDetailKeys(w: TsWriter, keysVar: string, pkType: string): void {
  w.line(`details: () => [...${keysVar}.all(), "detail"] as const,`);
  w.line(`detail: (id: ${pkType}) => [...${keysVar}.details(), id] as const,`);
}

// ---------------------------------------------------------------------------
// Read-only path (projections)
// ---------------------------------------------------------------------------

function writeReadOnlyHooksFile(w: TsWriter, entity: MetaObject, entityModule: string, ctx: RenderContext): void {
  const entityName = entity.name;
  // The id parameter must follow the entity's DECLARED primary-key type — a uuid/string
  // PK typed as `number` is simply wrong for the data (and a tsc error at every call site).
  const pkType = getPkInfo(entity, ctx).tsType;
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;
  const m2mEntries = m2mEntriesFor(entity, ctx);

  writeHeader(w, entity);
  const meta = w.use(entityName, metaModuleOf(entity, ctx));
  const row = w.useType(entityName, entityModule, `${entityName}Row`);
  const filter = w.useType(`${entityName}Filter`, entityModule);
  const path = sub(`${meta}.$path`);

  // A keyless projection (no identity and no `id` column) is served GET list only: the route
  // generator mounts no `/:id`, so a detail hook would fetch an address nothing answers.
  // It gets the list hook and no `details`/`detail` keys. A keyed projection is unchanged.
  const keyed = hasItemRoute(entity);
  w.blank();
  w.block(`export const ${keysVar} = {`, () => {
    writeListKeys(w, keysVar, lcEntity, filter);
    if (keyed) writeDetailKeys(w, keysVar, pkType);
    if (m2mEntries.length > 0) writeM2mKey(w, keysVar, pkType);
  }, "};");

  if (keyed) writeDetailHook(w, `use${entityName}`, row, pkType, path, `${keysVar}.detail(id)`);
  writeListHook(w, `use${hookListNameSegment(entity)}`, row, filter, path, `${keysVar}.list(filter)`);
  writeM2mHooks(w, entity, ctx, keysVar, m2mEntries);
}

// ---------------------------------------------------------------------------
// Full path (writable entities — table-backed or write-through)
// ---------------------------------------------------------------------------

function writeFullHooksFile(w: TsWriter, entity: MetaObject, entityModule: string, ctx: RenderContext): void {
  const entityName = entity.name;
  // The id parameter must follow the entity's DECLARED primary-key type — a uuid/string
  // PK typed as `number` is simply wrong for the data (and a tsc error at every call site).
  const pkType = getPkInfo(entity, ctx).tsType;
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;
  const m2mEntries = m2mEntriesFor(entity, ctx);

  writeHeader(w, entity);
  const meta = w.use(entityName, metaModuleOf(entity, ctx));
  const row = w.useType(entityName, entityModule, `${entityName}Row`);
  const insert = w.useType(`${entityName}Insert`, entityModule);
  const update = w.useType(`${entityName}Update`, entityModule);
  const filter = w.useType(`${entityName}Filter`, entityModule);
  const path = sub(`${meta}.$path`);

  w.blank();
  w.block(`export const ${keysVar} = {`, () => {
    writeListKeys(w, keysVar, lcEntity, filter);
    writeDetailKeys(w, keysVar, pkType);
    if (m2mEntries.length > 0) writeM2mKey(w, keysVar, pkType);
  }, "};");

  writeDetailHook(w, `use${entityName}`, row, pkType, path, `${keysVar}.detail(id)`);
  writeListHook(w, `use${hookListNameSegment(entity)}`, row, filter, path, `${keysVar}.list(filter)`);
  writeM2mHooks(w, entity, ctx, keysVar, m2mEntries);
  writeCrudMutations(w, { name: entityName, row, createInput: insert, updateInput: update, pkType, path, keysVar });
}

// ---------------------------------------------------------------------------
// FR-017 Tier 3 — TPH discriminator base: polymorphic + per-subtype hooks.
// ---------------------------------------------------------------------------

function writeTphHooksFile(w: TsWriter, base: MetaObject, ctx: RenderContext, baseModule: string): void {
  const baseName = base.name;
  // The id parameter must follow the entity's DECLARED primary-key type — a uuid/string
  // PK typed as `number` is simply wrong for the data (and a tsc error at every call site).
  const pkType = getPkInfo(base, ctx).tsType;
  const lcBase = baseName.charAt(0).toLowerCase() + baseName.slice(1);
  const keysVar = `${lcBase}Keys`;
  // Single source of truth for discriminator field + subtypes + route segments.
  const plan = tphPlan(base, ctx.loadedRoot)!;
  const discField = plan.discriminatorField;

  writeHeader(w, base, "TPH discriminator base");
  // `${baseName}` imports BOTH the constants value (for $path) and the
  // discriminated-union type (declaration merge). Each subtype contributes its
  // interface type AND its own filter type (discriminator-excluded — the route
  // pins it), so per-subtype hooks filter on the fields the per-subtype
  // allowlist actually permits.
  const baseRef = w.use(baseName, baseModule);
  const baseFilter = w.useType(`${baseName}Filter`, baseModule);
  const path = sub(`${baseRef}.$path`);

  w.blank();
  w.block(`export const ${keysVar} = {`, () => {
    writeListKeys(w, keysVar, lcBase, baseFilter);
    writeDetailKeys(w, keysVar, pkType);
    w.line(`subtypeLists: (sub: string) => [...${keysVar}.all(), sub, "list"] as const,`);
    w.line("// filter is loosely typed here (cache-key identity only); the per-subtype");
    w.line("// hooks below type it precisely as <Sub>Filter.");
    w.line(`subtypeList: (sub: string, filter?: unknown) => [...${keysVar}.subtypeLists(sub), filter ?? {}] as const,`);
    w.line(`subtypeDetails: (sub: string) => [...${keysVar}.all(), sub, "detail"] as const,`);
    w.line(`subtypeDetail: (sub: string, id: ${pkType}) => [...${keysVar}.subtypeDetails(sub), id] as const,`);
  }, "};");

  // Polymorphic reads — return the discriminated union.
  writeDetailHook(w, `use${baseName}`, baseRef, pkType, path, `${keysVar}.detail(id)`);
  writeListHook(w, `use${hookListNameSegment(base)}`, baseRef, baseFilter, path, `${keysVar}.list(filter)`);

  // Per-subtype hooks — scoped to each discriminator value's REST sub-path.
  for (const { entity: subEntity, value, routeSegment: seg } of plan.subtypes) {
    const m = entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, effectivePackage(subEntity), subEntity.name, ctx.extStyle);
    const subName = w.useType(subEntity.name, m);
    const subFilter = w.useType(`${subEntity.name}Filter`, m);
    const valueLit = str(value);
    const createInput = `Omit<${subName}, ${str(discField)}>`;
    const subPath = `${path}/${seg}`;
    writeListHook(w, `use${hookListNameSegment(subEntity)}`, subName, subFilter, subPath, `${keysVar}.subtypeList(${valueLit}, filter)`);
    writeDetailHook(w, `use${subName}`, subName, pkType, subPath, `${keysVar}.subtypeDetail(${valueLit}, id)`);
    writeCrudMutations(w, {
      name: subName,
      row: subName,
      createInput,
      updateInput: `Partial<${createInput}>`,
      pkType,
      path: subPath,
      keysVar,
    });
  }
}
