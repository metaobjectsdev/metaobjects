import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { serviceModelOf, serviceRenderContext } from "../service-walk.js";
import { renderServiceFiles } from "../templates/service-file.js";

/**
 * The service layer (ADR-0067 §1, layer 4): one module per metadata package, one file per
 * operation, and `create<Pkg>Service(deps)`. Each covered entity gets its derived list, get,
 * create, update and delete; every write runs in one transaction with the declared write rules
 * (ADR-0045). Hand-written code calls the service; a transport (`serviceRoutesFile()`) mounts it.
 *
 * Imports the entity module (the Drizzle table and allowlists, `entityFile()`) and the contract
 * types (`contractTypes()`), so list both. The built-in twin of `src/reference/service.ts`
 * (ADR-0034 scaffold-and-own); the reference-byte-identical gate holds the two to the same output.
 *
 * A SEPARATE generator: a project that does not list it sees no change (`fixtures/codegen-noop/rules`).
 */
export interface ServiceFileOpts {
  /** Narrow which entities get operations. ANDed with the generator's own gates, so it can only narrow. */
  filter?: (entity: MetaObject) => boolean;
  /** Where the emitted files import `@metaobjectsdev/runtime-ts/service` from. Absent: the package. */
  runtimeImport?: string;
  /** Named output target. It must be the entity module's target. */
  target?: string;
}

export function serviceFile(opts?: ServiceFileOpts): Generator {
  const generator: Generator = {
    name: "service",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = serviceModelOf(ctx.loadedRoot, { matches });
      if (model.length === 0) return [];
      const rc = serviceRenderContext(ctx, "service", opts?.runtimeImport);
      return model.flatMap((pkg) => renderServiceFiles(pkg, rc));
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
