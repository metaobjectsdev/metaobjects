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

import { TsWriter } from "@metaobjectsdev/codegen-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  type RenderContext,
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  entityModuleSpecifier,
  effectivePackage,
} from "@metaobjectsdev/codegen-ts";

/** The Angular service for `entity`, as a file. */
export function renderServiceFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeServiceFile(w, entity, ctx);
  return w.toString();
}

/** Write the `<Entity>Service` @Injectable for `entity` into `w`. */
export function writeServiceFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entityName,
    ctx.extStyle,
  );

  w.header(
    `// ${GENERATED_HEADER}-angular — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
  );
  const row = w.useType(entityName, entityFileSpec, `${entityName}Row`);
  const meta = w.use(entityName, entityFileSpec);
  const path = `\${${meta}.$path}`;
  const ANGULAR = "@metaobjectsdev/angular";

  w.blank();
  w.block(`export interface ${entityName}ListOpts {`, () => {
    w.line("filter?: Record<string, unknown>;");
    w.line("sort?: string;");
    w.line("limit?: number;");
    w.line("offset?: number;");
    w.line("withCount?: 0 | 1;");
  });
  w.blank();
  w.doc(
    `Generated Angular service for ${entityName}.`,
    "",
    "Wraps the injected EntityFetcher with typed CRUD methods conforming to the",
    "cross-port REST URL grammar. Inject anywhere in your component tree —",
    "provided in root.",
  );
  w.line(`@${w.use("Injectable", "@angular/core")}({ providedIn: "root" })`);
  w.block(`export class ${entityName}Service {`, () => {
    w.line(`private readonly fetcher = ${w.use("inject", "@angular/core")}(${w.use("EntityFetcherToken", ANGULAR)});`);
    w.blank();
    w.block(`list(opts?: ${entityName}ListOpts): Promise<${row}[]> {`, () => {
      w.line("const params: Record<string, unknown> = { ...(opts?.filter ?? {}) };");
      for (const opt of ["sort", "limit", "offset", "withCount"]) {
        w.block(`if (opts?.${opt} !== undefined) {`, () => w.line(`params["${opt}"] = opts.${opt};`));
      }
      w.line(`const qs = Object.keys(params).length > 0 ? "?" + ${w.use("buildFilterQs", ANGULAR)}(params) : "";`);
      w.line(`return this.fetcher<${row}[]>(\`${path}\${qs}\`);`);
    });
    w.blank();
    w.block(`get(id: number | string): Promise<${row}> {`, () => {
      w.line(`return this.fetcher<${row}>(\`${path}/\${id}\`);`);
    });
    const write = (head: string, url: string, method: string, body: string): void => {
      w.blank();
      w.block(head, () => {
        w.block(`return this.fetcher<${row}>(\`${url}\`, {`, () => {
          w.line(`method: "${method}",`);
          w.line('headers: { "Content-Type": "application/json" },');
          w.line(`body: JSON.stringify(${body}),`);
        }, "});");
      });
    };
    write(`create(dto: Partial<${row}>): Promise<${row}> {`, path, "POST", "dto");
    write(`update(id: number | string, patch: Partial<${row}>): Promise<${row}> {`, `${path}/\${id}`, "PATCH", "patch");
    w.blank();
    w.block("delete(id: number | string): Promise<void> {", () => {
      w.line(`return this.fetcher<void>(\`${path}/\${id}\`, { method: "DELETE" });`);
    });
  });
}
