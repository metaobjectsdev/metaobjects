import { isMetaObject, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import { serviceModelOf, serviceRenderContext } from "../service-walk.js";
import { renderServiceFiles } from "../templates/service-file.js";

/**
 * The service layer (ADR-0067 §1, layer 4): one module per metadata package, one file per
 * operation, and `create<Pkg>Service(deps)`. Each covered entity gets its derived list, get,
 * create, update and delete; every write runs in one transaction with the declared write rules
 * (ADR-0045). Each transition that derives a command (`rules.lifecycle.commands`) and each declared
 * command and query gets its shell, which runs ADR-0066 §6's checks around the hand-written body.
 * The policy, bodies, hooks and event hook are passed in `deps`, through the interfaces the index
 * declares. Hand-written code calls the service; a transport (`serviceRoutesFile()`) mounts it.
 *
 * SQLite takes a sync or an async Drizzle driver: the runtime drives a sync driver's transaction
 * (bun:sqlite, better-sqlite3) with statements. For Cloudflare D1, which holds no transaction across
 * application code, pass `interactiveTransactions: false`.
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
  /**
   * False for a store that cannot hold a transaction across application code (Cloudflare D1).
   * The service then opens no transaction: each derived write is its one statement, and a
   * transition is its guarded update, which holds on its own. There are no hooks and no event
   * hook, which would run inside the write's transaction, and a package that declares a command is
   * refused with `ERR_STORE_NO_INTERACTIVE_TX` (ADR-0067 §4). Default true.
   */
  interactiveTransactions?: boolean;
  /** The most rows a served report answers with no `limit` (the routes generator's option of the same name). Default 10000. */
  reportMaxRows?: number;
}

export function serviceFile(opts?: ServiceFileOpts): Generator {
  const generator: Generator = {
    name: "service",
    generate: (ctx: GenContext): EmittedFile[] => {
      const matches = (obj: MetaData): boolean => isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = serviceModelOf(ctx.loadedRoot, { matches });
      if (model.length === 0) return [];
      const rc = serviceRenderContext(ctx, "service", opts?.runtimeImport);
      const interactiveTransactions = opts?.interactiveTransactions !== false;
      const reportMaxRows = opts?.reportMaxRows;
      return model.flatMap((pkg) => renderServiceFiles({ ...pkg, interactiveTransactions, ...(reportMaxRows === undefined ? {} : { reportMaxRows }) }, rc));
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
