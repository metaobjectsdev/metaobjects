import { code, imp, joinCode, Import, type Code } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import type { RenderContext, RelationEntry } from "@metaobjectsdev/codegen-ts";
import {
  GENERATED_HEADER,
  isProjection,
  pluralize,
  entityModuleSpecifier,
  isTphDiscriminatorBase,
  tphPlan,
} from "@metaobjectsdev/codegen-ts";

/**
 * Render <Entity>.hooks.ts — query-key factory + 2 query hooks + (for non-projections) 3 mutation hooks.
 *
 * Projections (view-backed, read-only) emit only:
 *   - <camel>Keys query-key factory
 *   - use<Entity>(id)       — useQuery on GET :id
 *   - use<Entities>(filter) — useQuery on list
 *
 * Full (writable) entities additionally emit:
 *   - useCreate<Entity>
 *   - useUpdate<Entity>
 *   - useDelete<Entity>
 *
 * All hooks call useEntityFetcher() (from @metaobjectsdev/tanstack) for
 * the underlying HTTP. Mutations aggressively invalidate <entity>Keys.all().
 */
export function renderHooksFile(entity: MetaObject, ctx: RenderContext): string {
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entity.name,
    ctx.extStyle,
  );
  // FR-017 Tier 3: a TPH discriminator base gets a polymorphic + per-subtype
  // hooks file (the subtype entities are filtered out of this generator).
  if (isTphDiscriminatorBase(entity, ctx.loadedRoot)) {
    return renderTphHooksFile(entity, ctx, entityModule);
  }
  if (isProjection(entity)) {
    return renderReadOnlyHooksFile(entity, entityModule, ctx);
  }
  return renderFullHooksFile(entity, entityModule, ctx);
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

/** The `relation: (relation, sourceId) => ...` query-key factory line, included
 *  in the keys factory ONLY when the entity has M:N relationships. */
function m2mKeyLine(keysVar: string): string {
  return (
    `  relation: (relation: string, sourceId: number | undefined) =>\n` +
    `    [...${keysVar}.all(), "relation", relation, sourceId ?? null] as const,`
  );
}

/**
 * Render `use<Source><Relation>(sourceId, opts?)` per M:N relationship. Returns
 * null when the entity has no M:N relationships (no extra hooks emitted).
 */
function renderM2mHooks(
  entity: MetaObject,
  ctx: RenderContext,
  keysVar: string,
  entries: RelationEntry[],
): Code | null {
  if (entries.length === 0) return null;

  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");

  const source = entity.name;

  // Distinct target row types, imported (aliased) from each target's entity
  // module. ts-poet's imp() tracks + hoists these into the import block. The
  // <Target>RelRow alias avoids colliding with the source file's own
  // `type <Source> as <Source>Row` import on a self-join (source === target).
  const targetTypeSym = new Map<string, Import>();
  for (const e of entries) {
    if (targetTypeSym.has(e.targetEntity)) continue;
    const mod = entityModuleSpecifier(
      ctx.selfTarget,
      ctx.entityModuleTarget,
      ctx.packageOf.get(e.targetEntity),
      e.targetEntity,
      ctx.extStyle,
    );
    // `import { type <Target> as <Target>RelRow } from "<mod>"` — the RelRow
    // alias avoids colliding with the source file's own `type <Source> as
    // <Source>Row` import on a self-join (source === target).
    targetTypeSym.set(
      e.targetEntity,
      Import.importsName(`${e.targetEntity}RelRow`, mod, true, e.targetEntity),
    );
  }

  const hooks = entries.map((e) => {
    const targetSym = targetTypeSym.get(e.targetEntity)!;
    const hookName = `use${source}${capitalize(e.name)}`;
    const relLit = JSON.stringify(e.name);
    return code`
export function ${hookName}(
  sourceId: number | undefined,
  opts?: Omit<${useQueryOptionsSym}<${targetSym}[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${targetSym}[]> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${targetSym}[]>({
    queryKey: ${keysVar}.relation(${relLit}, sourceId),
    queryFn: () => fetcher<${targetSym}[]>(\`\${${source}.$apiPrefix}\${${source}.$path}/\${sourceId}/${e.name}\`),
    enabled: sourceId != null && (opts?.enabled ?? true),
    ...opts,
  });
}
`;
  });

  return joinCode(hooks, { on: "\n" });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Read-only path (projections)
// ---------------------------------------------------------------------------

function renderReadOnlyHooksFile(entity: MetaObject, entityModule: string, ctx: RenderContext): string {
  const entityName = entity.name;
  const entityNamePlural = pluralize(entityName);
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;
  const m2mEntries = m2mEntriesFor(entity, ctx);
  const relationKeyLine = m2mEntries.length > 0 ? `\n${m2mKeyLine(keysVar)}` : "";

  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjectsdev/runtime-web");

  const entityImports: Code = code`
import {
  ${entityName},
  type ${entityName} as ${entityName}Row,
  type ${entityName}Filter,
} from ${JSON.stringify(entityModule)};
`;

  const queryKeys: Code = code`
export const ${keysVar} = {
  all:     () => [${JSON.stringify(lcEntity)}] as const,
  lists:   () => [...${keysVar}.all(), "list"] as const,
  list:    (filter?: ${entityName}Filter) => [...${keysVar}.lists(), filter ?? {}] as const,
  details: () => [...${keysVar}.all(), "detail"] as const,
  detail:  (id: number) => [...${keysVar}.details(), id] as const,${relationKeyLine}
};
`;

  const queries: Code = code`
export function use${entityName}(
  id: number,
  opts?: Omit<${useQueryOptionsSym}<${entityName}Row>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${entityName}Row> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${entityName}Row>({
    queryKey: ${keysVar}.detail(id),
    queryFn: () => fetcher<${entityName}Row>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}/\${id}\`),
    ...opts,
  });
}

export function use${entityNamePlural}(
  filter?: ${entityName}Filter,
  opts?: Omit<${useQueryOptionsSym}<${entityName}Row[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${entityName}Row[]> {
  const fetcher = ${useEntityFetcherSym}();
  const qs = filter ? "?" + ${buildFilterQsSym}(filter as Record<string, unknown>) : "";
  return ${useQuerySym}<${entityName}Row[]>({
    queryKey: ${keysVar}.list(filter),
    queryFn: () => fetcher<${entityName}Row[]>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}\${qs}\`),
    ...opts,
  });
}
`;

  const m2mHooks = renderM2mHooks(entity, ctx, keysVar, m2mEntries);
  const body: Code = joinCode(m2mHooks ? [queryKeys, queries, m2mHooks] : [queryKeys, queries], { on: "\n" });

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + entityImports.toString() + body.toString();
}

// ---------------------------------------------------------------------------
// Full path (writable entities — table-backed or write-through)
// ---------------------------------------------------------------------------

function renderFullHooksFile(entity: MetaObject, entityModule: string, ctx: RenderContext): string {
  const entityName = entity.name;
  const entityNamePlural = pluralize(entityName);
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;
  const m2mEntries = m2mEntriesFor(entity, ctx);
  const relationKeyLine = m2mEntries.length > 0 ? `\n${m2mKeyLine(keysVar)}` : "";

  const useMutationSym = imp("useMutation@@tanstack/react-query");
  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useQueryClientSym = imp("useQueryClient@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useMutationOptionsSym = imp("t:UseMutationOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useMutationResultSym = imp("t:UseMutationResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjectsdev/runtime-web");

  const entityImports: Code = code`
import {
  ${entityName},
  type ${entityName} as ${entityName}Row,
  type ${entityName}Insert,
  type ${entityName}Update,
  type ${entityName}Filter,
} from ${JSON.stringify(entityModule)};
`;

  const queryKeys: Code = code`
export const ${keysVar} = {
  all:     () => [${JSON.stringify(lcEntity)}] as const,
  lists:   () => [...${keysVar}.all(), "list"] as const,
  list:    (filter?: ${entityName}Filter) => [...${keysVar}.lists(), filter ?? {}] as const,
  details: () => [...${keysVar}.all(), "detail"] as const,
  detail:  (id: number) => [...${keysVar}.details(), id] as const,${relationKeyLine}
};
`;

  const queries: Code = code`
export function use${entityName}(
  id: number,
  opts?: Omit<${useQueryOptionsSym}<${entityName}Row>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${entityName}Row> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${entityName}Row>({
    queryKey: ${keysVar}.detail(id),
    queryFn: () => fetcher<${entityName}Row>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}/\${id}\`),
    ...opts,
  });
}

export function use${entityNamePlural}(
  filter?: ${entityName}Filter,
  opts?: Omit<${useQueryOptionsSym}<${entityName}Row[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${entityName}Row[]> {
  const fetcher = ${useEntityFetcherSym}();
  const qs = filter ? "?" + ${buildFilterQsSym}(filter as Record<string, unknown>) : "";
  return ${useQuerySym}<${entityName}Row[]>({
    queryKey: ${keysVar}.list(filter),
    queryFn: () => fetcher<${entityName}Row[]>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}\${qs}\`),
    ...opts,
  });
}
`;

  const m2mHooks = renderM2mHooks(entity, ctx, keysVar, m2mEntries);

  const mutations: Code = code`
export function useCreate${entityName}(
  opts?: Omit<${useMutationOptionsSym}<${entityName}Row, Error, ${entityName}Insert>, "mutationFn">,
): ${useMutationResultSym}<${entityName}Row, Error, ${entityName}Insert> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}<${entityName}Row, Error, ${entityName}Insert>({
    mutationFn: (input) => fetcher<${entityName}Row>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}

export function useUpdate${entityName}(
  opts?: Omit<${useMutationOptionsSym}<${entityName}Row, Error, { id: number; input: ${entityName}Update }>, "mutationFn">,
): ${useMutationResultSym}<${entityName}Row, Error, { id: number; input: ${entityName}Update }> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}({
    mutationFn: ({ id, input }) => fetcher<${entityName}Row>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}/\${id}\`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}

export function useDelete${entityName}(
  opts?: Omit<${useMutationOptionsSym}<void, Error, number>, "mutationFn">,
): ${useMutationResultSym}<void, Error, number> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}({
    mutationFn: (id) => fetcher<void>(\`\${${entityName}.$apiPrefix}\${${entityName}.$path}/\${id}\`, { method: "DELETE" }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}
`;

  const body: Code = joinCode(
    m2mHooks ? [queryKeys, queries, m2mHooks, mutations] : [queryKeys, queries, mutations],
    { on: "\n" },
  );

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + entityImports.toString() + body.toString();
}

// ---------------------------------------------------------------------------
// FR-017 Tier 3 — TPH discriminator base: polymorphic + per-subtype hooks.
// ---------------------------------------------------------------------------

function renderTphHooksFile(base: MetaObject, ctx: RenderContext, baseModule: string): string {
  const baseName = base.name;
  const lcBase = baseName.charAt(0).toLowerCase() + baseName.slice(1);
  const keysVar = `${lcBase}Keys`;
  // Single source of truth for discriminator field + subtypes + route segments.
  const plan = tphPlan(base, ctx.loadedRoot)!;
  const discField = plan.discriminatorField;

  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useMutationSym = imp("useMutation@@tanstack/react-query");
  const useQueryClientSym = imp("useQueryClient@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useMutationOptionsSym = imp("t:UseMutationOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useMutationResultSym = imp("t:UseMutationResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjectsdev/runtime-web");

  const subtypes = plan.subtypes;

  // `${baseName}` imports BOTH the constants value (for $path/$apiPrefix) and the
  // discriminated-union type (declaration merge). Each subtype contributes its
  // interface type AND its own filter type (discriminator-excluded — the route
  // pins it), so per-subtype hooks filter on the fields the per-subtype
  // allowlist actually permits.
  const subImportLines = subtypes
    .map((s) => {
      const m = entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, s.entity.package, s.entity.name, ctx.extStyle);
      return `import { type ${s.entity.name}, type ${s.entity.name}Filter } from ${JSON.stringify(m)};`;
    })
    .join("\n");
  const entityImports: Code = code`
import { ${baseName}, type ${baseName}Filter } from ${JSON.stringify(baseModule)};
${subImportLines}
`;

  const queryKeys: Code = code`
export const ${keysVar} = {
  all:           () => [${JSON.stringify(lcBase)}] as const,
  lists:         () => [...${keysVar}.all(), "list"] as const,
  list:          (filter?: ${baseName}Filter) => [...${keysVar}.lists(), filter ?? {}] as const,
  details:       () => [...${keysVar}.all(), "detail"] as const,
  detail:        (id: number) => [...${keysVar}.details(), id] as const,
  subtypeLists:  (sub: string) => [...${keysVar}.all(), sub, "list"] as const,
  // filter is loosely typed here (cache-key identity only); the per-subtype
  // hooks below type it precisely as <Sub>Filter.
  subtypeList:   (sub: string, filter?: unknown) => [...${keysVar}.subtypeLists(sub), filter ?? {}] as const,
  subtypeDetails:(sub: string) => [...${keysVar}.all(), sub, "detail"] as const,
  subtypeDetail: (sub: string, id: number) => [...${keysVar}.subtypeDetails(sub), id] as const,
};
`;

  // Polymorphic reads — return the discriminated union.
  const polymorphic: Code = code`
export function use${baseName}(
  id: number,
  opts?: Omit<${useQueryOptionsSym}<${baseName}>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${baseName}> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${baseName}>({
    queryKey: ${keysVar}.detail(id),
    queryFn: () => fetcher<${baseName}>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/\${id}\`),
    ...opts,
  });
}

export function use${pluralize(baseName)}(
  filter?: ${baseName}Filter,
  opts?: Omit<${useQueryOptionsSym}<${baseName}[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${baseName}[]> {
  const fetcher = ${useEntityFetcherSym}();
  const qs = filter ? "?" + ${buildFilterQsSym}(filter as Record<string, unknown>) : "";
  return ${useQuerySym}<${baseName}[]>({
    queryKey: ${keysVar}.list(filter),
    queryFn: () => fetcher<${baseName}[]>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}\${qs}\`),
    ...opts,
  });
}
`;

  // Per-subtype hooks — scoped to each discriminator value's REST sub-path.
  const subtypeSections: Code[] = subtypes.map(({ entity: subEntity, value, routeSegment: seg }) => {
    const subName = subEntity.name;
    const valueLit = JSON.stringify(value);
    const createInput = `Omit<${subName}, ${JSON.stringify(discField)}>`;
    const updateInput = `Partial<${createInput}>`;
    const subPath = `\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}\``;
    return code`
export function use${pluralize(subName)}(
  filter?: ${subName}Filter,
  opts?: Omit<${useQueryOptionsSym}<${subName}[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${subName}[]> {
  const fetcher = ${useEntityFetcherSym}();
  const qs = filter ? "?" + ${buildFilterQsSym}(filter as Record<string, unknown>) : "";
  return ${useQuerySym}<${subName}[]>({
    queryKey: ${keysVar}.subtypeList(${valueLit}, filter),
    queryFn: () => fetcher<${subName}[]>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}\${qs}\`),
    ...opts,
  });
}

export function use${subName}(
  id: number,
  opts?: Omit<${useQueryOptionsSym}<${subName}>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${subName}> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${subName}>({
    queryKey: ${keysVar}.subtypeDetail(${valueLit}, id),
    queryFn: () => fetcher<${subName}>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}/\${id}\`),
    ...opts,
  });
}

export function useCreate${subName}(
  opts?: Omit<${useMutationOptionsSym}<${subName}, Error, ${createInput}>, "mutationFn">,
): ${useMutationResultSym}<${subName}, Error, ${createInput}> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}<${subName}, Error, ${createInput}>({
    mutationFn: (input) => fetcher<${subName}>(${subPath}, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}

export function useUpdate${subName}(
  opts?: Omit<${useMutationOptionsSym}<${subName}, Error, { id: number; input: ${updateInput} }>, "mutationFn">,
): ${useMutationResultSym}<${subName}, Error, { id: number; input: ${updateInput} }> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}({
    mutationFn: ({ id, input }) => fetcher<${subName}>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}/\${id}\`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}

export function useDelete${subName}(
  opts?: Omit<${useMutationOptionsSym}<void, Error, number>, "mutationFn">,
): ${useMutationResultSym}<void, Error, number> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}({
    mutationFn: (id) => fetcher<void>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}/\${id}\`, { method: "DELETE" }),
    ...opts,
    onSuccess: (...args) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(...args);
    },
  });
}
`;
  });

  const body: Code = joinCode([queryKeys, polymorphic, ...subtypeSections], { on: "\n" });
  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${baseName} (${base.fqn()}) — TPH discriminator base\n`;
  return header + entityImports.toString() + body.toString();
}
