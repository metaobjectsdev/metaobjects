// Angular 18 service template — emits a per-entity @Injectable wrapping the
// EntityFetcher with typed CRUD methods that conform to the cross-port REST URL
// grammar (docs/features/api-contract.md).
//
// The generated file imports the entity Row type from the entity module + the
// EntityFetcherToken from @metaobjectsdev/angular. Method shape:
//
//   list(opts?: ListOpts) → GET /api/<entity>?...
//   get(id)               → GET /api/<entity>/:id
//   create(dto)           → POST /api/<entity>
//   update(id, patch)     → PATCH /api/<entity>/:id
//   delete(id)            → DELETE /api/<entity>/:id

import { code, imp } from "ts-poet";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  type RenderContext,
  GENERATED_HEADER,
  entityModuleSpecifier,
} from "@metaobjectsdev/codegen-ts";

export function renderServiceFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const lcEntity = entityName.charAt(0).toLowerCase() + entityName.slice(1);

  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );

  const InjectableSym = imp("Injectable@@angular/core");
  const injectSym = imp("inject@@angular/core");
  const EntityFetcherTokenSym = imp("EntityFetcherToken@@metaobjectsdev/angular");
  const buildFilterQsSym = imp("buildFilterQs@@metaobjectsdev/angular");

  const literalImports = code`
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityFileSpec)};
import { ${entityName} } from ${JSON.stringify(entityFileSpec)};
`;

  const body = code`
export interface ${entityName}ListOpts {
  filter?: Record<string, unknown>;
  sort?:   string;
  limit?:  number;
  offset?: number;
  withCount?: 0 | 1;
}

/**
 * Generated Angular service for ${entityName}.
 *
 * Wraps the injected EntityFetcher with typed CRUD methods conforming to the
 * cross-port REST URL grammar. Inject anywhere in your component tree —
 * provided in root.
 */
@${InjectableSym}({ providedIn: "root" })
export class ${entityName}Service {
  private readonly fetcher = ${injectSym}(${EntityFetcherTokenSym});

  list(opts?: ${entityName}ListOpts): Promise<${entityName}Row[]> {
    const params: Record<string, unknown> = { ...(opts?.filter ?? {}) };
    if (opts?.sort   !== undefined) params["sort"]      = opts.sort;
    if (opts?.limit  !== undefined) params["limit"]     = opts.limit;
    if (opts?.offset !== undefined) params["offset"]    = opts.offset;
    if (opts?.withCount !== undefined) params["withCount"] = opts.withCount;
    const qs = Object.keys(params).length > 0 ? "?" + ${buildFilterQsSym}(params) : "";
    return this.fetcher<${entityName}Row[]>(\`\${${entityName}.$path}\${qs}\`);
  }

  get(id: number | string): Promise<${entityName}Row> {
    return this.fetcher<${entityName}Row>(\`\${${entityName}.$path}/\${id}\`);
  }

  create(dto: Partial<${entityName}Row>): Promise<${entityName}Row> {
    return this.fetcher<${entityName}Row>(\`\${${entityName}.$path}\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dto),
    });
  }

  update(id: number | string, patch: Partial<${entityName}Row>): Promise<${entityName}Row> {
    return this.fetcher<${entityName}Row>(\`\${${entityName}.$path}/\${id}\`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  delete(id: number | string): Promise<void> {
    return this.fetcher<void>(\`\${${entityName}.$path}/\${id}\`, {
      method: "DELETE",
    });
  }
}
`;

  const _ = lcEntity; // reserved for future per-entity naming hooks
  void _;

  const header =
    `// ${GENERATED_HEADER}-angular — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + literalImports.toString() + body.toString();
}
