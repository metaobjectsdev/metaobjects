import { code, imp, joinCode, type Code } from "ts-poet";
import {
  type MetaObject,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts";
import {
  GENERATED_HEADER,
  isProjection,
  pluralize,
  entityModuleSpecifier,
  isTphDiscriminatorBase,
  tphConcreteSubtypes,
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
    return renderReadOnlyHooksFile(entity, entityModule);
  }
  return renderFullHooksFile(entity, entityModule);
}

// ---------------------------------------------------------------------------
// Read-only path (projections)
// ---------------------------------------------------------------------------

function renderReadOnlyHooksFile(entity: MetaObject, entityModule: string): string {
  const entityName = entity.name;
  const entityNamePlural = pluralize(entityName);
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;

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
  detail:  (id: number) => [...${keysVar}.details(), id] as const,
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

  const body: Code = joinCode([queryKeys, queries], { on: "\n" });

  const header =
    `// ${GENERATED_HEADER}-tanstack — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + entityImports.toString() + body.toString();
}

// ---------------------------------------------------------------------------
// Full path (writable entities — table-backed or write-through)
// ---------------------------------------------------------------------------

function renderFullHooksFile(entity: MetaObject, entityModule: string): string {
  const entityName = entity.name;
  const entityNamePlural = pluralize(entityName);
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;

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
  detail:  (id: number) => [...${keysVar}.details(), id] as const,
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

  const body: Code = joinCode([queryKeys, queries, mutations], { on: "\n" });

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
  const discField = base.ownAttr(OBJECT_ATTR_DISCRIMINATOR) as string;

  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useMutationSym = imp("useMutation@@tanstack/react-query");
  const useQueryClientSym = imp("useQueryClient@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useMutationOptionsSym = imp("t:UseMutationOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useMutationResultSym = imp("t:UseMutationResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjectsdev/tanstack");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjectsdev/runtime-web");

  const subtypes = tphConcreteSubtypes(base, ctx.loadedRoot);

  // `${baseName}` imports BOTH the constants value (for $path/$apiPrefix) and the
  // discriminated-union type (declaration merge). Each subtype contributes its
  // interface type.
  const subImportLines = subtypes
    .map((s) => {
      const m = entityModuleSpecifier(ctx.selfTarget, ctx.entityModuleTarget, s.package, s.name, ctx.extStyle);
      return `import { type ${s.name} } from ${JSON.stringify(m)};`;
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
  subtypeList:   (sub: string, filter?: ${baseName}Filter) => [...${keysVar}.subtypeLists(sub), filter ?? {}] as const,
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
  const subtypeSections: Code[] = subtypes.map((sub) => {
    const value = sub.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) as string;
    const seg = value.toLowerCase();
    const valueLit = JSON.stringify(value);
    const createInput = `Omit<${sub.name}, ${JSON.stringify(discField)}>`;
    const updateInput = `Partial<${createInput}>`;
    const subPath = `\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}\``;
    return code`
export function use${pluralize(sub.name)}(
  filter?: ${baseName}Filter,
  opts?: Omit<${useQueryOptionsSym}<${sub.name}[]>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${sub.name}[]> {
  const fetcher = ${useEntityFetcherSym}();
  const qs = filter ? "?" + ${buildFilterQsSym}(filter as Record<string, unknown>) : "";
  return ${useQuerySym}<${sub.name}[]>({
    queryKey: ${keysVar}.subtypeList(${valueLit}, filter),
    queryFn: () => fetcher<${sub.name}[]>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}\${qs}\`),
    ...opts,
  });
}

export function use${sub.name}(
  id: number,
  opts?: Omit<${useQueryOptionsSym}<${sub.name}>, "queryKey" | "queryFn">,
): ${useQueryResultSym}<${sub.name}> {
  const fetcher = ${useEntityFetcherSym}();
  return ${useQuerySym}<${sub.name}>({
    queryKey: ${keysVar}.subtypeDetail(${valueLit}, id),
    queryFn: () => fetcher<${sub.name}>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}/\${id}\`),
    ...opts,
  });
}

export function useCreate${sub.name}(
  opts?: Omit<${useMutationOptionsSym}<${sub.name}, Error, ${createInput}>, "mutationFn">,
): ${useMutationResultSym}<${sub.name}, Error, ${createInput}> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}<${sub.name}, Error, ${createInput}>({
    mutationFn: (input) => fetcher<${sub.name}>(${subPath}, {
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

export function useUpdate${sub.name}(
  opts?: Omit<${useMutationOptionsSym}<${sub.name}, Error, { id: number; input: ${updateInput} }>, "mutationFn">,
): ${useMutationResultSym}<${sub.name}, Error, { id: number; input: ${updateInput} }> {
  const fetcher = ${useEntityFetcherSym}();
  const qc = ${useQueryClientSym}();
  return ${useMutationSym}({
    mutationFn: ({ id, input }) => fetcher<${sub.name}>(\`\${${baseName}.$apiPrefix}\${${baseName}.$path}/${seg}/\${id}\`, {
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

export function useDelete${sub.name}(
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
