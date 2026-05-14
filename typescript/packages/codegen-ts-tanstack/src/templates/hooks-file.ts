import { code, imp, joinCode, type Code } from "ts-poet";
import type { MetaModel } from "@metaobjects/metadata";
import type { RenderContext } from "@metaobjects/codegen-ts";
import { GENERATED_HEADER, isProjection, pluralize } from "@metaobjects/codegen-ts";

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
 * All hooks call useEntityFetcher() (from @metaobjects/runtime-ts-client) for
 * the underlying HTTP. Mutations aggressively invalidate <entity>Keys.all().
 */
export function renderHooksFile(entity: MetaModel, _ctx: RenderContext): string {
  if (isProjection(entity)) {
    return renderReadOnlyHooksFile(entity);
  }
  return renderFullHooksFile(entity);
}

// ---------------------------------------------------------------------------
// Read-only path (projections)
// ---------------------------------------------------------------------------

function renderReadOnlyHooksFile(entity: MetaModel): string {
  const entityName = entity.name;
  const entityNamePlural = pluralize(entityName);
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  const keysVar = `${lcEntity}Keys`;

  const useQuerySym = imp("useQuery@@tanstack/react-query");
  const useQueryOptionsSym = imp("t:UseQueryOptions@@tanstack/react-query");
  const useQueryResultSym = imp("t:UseQueryResult@@tanstack/react-query");
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjects/runtime-ts-client");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjects/runtime-ts-client");

  const entityImports: Code = code`
import {
  ${entityName},
  type ${entityName} as ${entityName}Row,
  type ${entityName}Filter,
} from "./${entityName}";
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

function renderFullHooksFile(entity: MetaModel): string {
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
  const useEntityFetcherSym = imp("useEntityFetcher@@metaobjects/runtime-ts-client");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjects/runtime-ts-client");

  const entityImports: Code = code`
import {
  ${entityName},
  type ${entityName} as ${entityName}Row,
  type ${entityName}Insert,
  type ${entityName}Update,
  type ${entityName}Filter,
} from "./${entityName}";
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
    onSuccess: (data, vars, ctx) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(data, vars, ctx);
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
    onSuccess: (data, vars, ctx) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(data, vars, ctx);
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
    onSuccess: (data, vars, ctx) => {
      qc.invalidateQueries({ queryKey: ${keysVar}.all() });
      opts?.onSuccess?.(data, vars, ctx);
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
