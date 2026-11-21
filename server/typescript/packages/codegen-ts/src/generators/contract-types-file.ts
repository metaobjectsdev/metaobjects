import { isMetaObject, OBJECT_SUBTYPE_VALUE, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";
import type { EmittedFile, GenContext, Generator } from "../generator.js";
import {
  CONTRACT_ERRORS_FILE,
  contractObjectPath,
  contractOperationsPath,
  contractSpecifier,
  contractTypesOf,
  contractValuePath,
  hasObjectContract,
} from "../contract-walk.js";
import { DEFAULT_OUTPUT_LAYOUT } from "../import-path.js";
import { claimModuleNames } from "../naming/name-claims.js";
import { renderValueObjectFile } from "../templates/value-object-file.js";
import { renderSharedEnumsFile, SHARED_ENUMS_BASENAME } from "../templates/enums-file.js";
import {
  renderErrorsContract,
  renderObjectContract,
  renderOperationsContract,
  type ContractShapeRef,
} from "../templates/contract-types.js";

/**
 * The contract types layer (ADR-0067 §1, layer 1): the shapes a caller and a service exchange,
 * with no persistence mapping in them, so a transport, a client or a job can import them without
 * the ORM.
 *
 * Writes, beside where the entity generator writes `<Name>.ts`:
 *   - `<Entity>.contract.ts` — the read schema and type, the create and update schemas, the typed
 *     create and patch inputs;
 *   - `<Projection>.contract.ts` — the read schema and type;
 *   - `<Value>.ts` for each value object the contract reaches — the entity generator's value
 *     module byte for byte, so when both run the two emissions collapse into one file;
 *   - `enums.ts` when a shared enum is materialized, likewise the entity generator's;
 *   - `errors.contract.ts` at the target root — the wire error bodies;
 *   - `<pkg path>/operations.contract.ts` per package that declares operations, in either layout.
 *
 * The built-in twin of `src/reference/contract-types.ts` (ADR-0034 scaffold-and-own); the
 * reference-byte-identical gate holds the two to the same output.
 *
 * A SEPARATE generator, never a branch inside the entity generator: a project that does not list
 * it sees no change (`fixtures/codegen-noop/rules`).
 */
export interface ContractTypesFileOpts {
  /** Narrow which objects are covered. ANDed with the generator's own gates, so it can only
   *  narrow; an operation with no target entity is always kept. */
  filter?: (entity: MetaObject) => boolean;
  /** Named output target, as on every other generator. */
  target?: string;
}

export function contractTypes(opts?: ContractTypesFileOpts): Generator {
  const generator: Generator = {
    name: "contract-types",
    generate: (ctx: GenContext): EmittedFile[] => {
      const rc = ctx.renderContext;
      if (!rc) throw new Error("contract-types: renderContext is required (provided by runGen)");
      const layout = ctx.config.outputLayout ?? DEFAULT_OUTPUT_LAYOUT;
      const matches = (obj: MetaData): boolean =>
        isMetaObject(obj) && ctx.matches(obj) && (ctx.selected?.(obj) ?? true);
      const model = contractTypesOf(ctx.loadedRoot, { matches });
      const files: EmittedFile[] = [];

      for (const obj of model.objects) {
        claimModuleNames(ctx, obj);
        files.push({ path: contractObjectPath(layout, obj), content: renderObjectContract(obj, rc) });
      }
      for (const v of model.values) {
        claimModuleNames(ctx, v);
        files.push({ path: contractValuePath(layout, v), content: renderValueObjectFile(v, rc.apiPrefix, rc) });
      }

      for (const pkg of model.packages) {
        const path = contractOperationsPath(pkg.package);
        // A value's module, or an object's contract module; an object with no contract of its
        // own (a report) is left out rather than imported from a file this run did not write.
        const shape = (obj: MetaObject | undefined, name: string): ContractShapeRef | undefined => {
          if (obj === undefined) return undefined;
          if (obj.subType === OBJECT_SUBTYPE_VALUE) return { name, from: contractSpecifier(path, contractValuePath(layout, obj), rc.extStyle) };
          if (!hasObjectContract(obj)) return undefined;
          return { name, from: contractSpecifier(path, contractObjectPath(layout, obj), rc.extStyle) };
        };
        const operations = pkg.operations.map((o) => {
          const input = o.input && shape(o.input, `${rc.valueObjectEmittedName(o.input)}InsertSchema`);
          const output = o.output && shape(o.output, o.output.subType === OBJECT_SUBTYPE_VALUE ? rc.valueObjectEmittedName(o.output) : o.output.name);
          return {
            name: o.name,
            kind: o.kind,
            many: o.many,
            errors: o.errors,
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
          };
        });
        const errors = contractSpecifier(path, CONTRACT_ERRORS_FILE, rc.extStyle);
        files.push({ path, content: renderOperationsContract(pkg.package, operations, errors) });
      }

      if (files.length === 0) return [];
      files.push({ path: CONTRACT_ERRORS_FILE, content: renderErrorsContract() });
      const sharedEnums = renderSharedEnumsFile(ctx.loadedRoot, ctx.select !== undefined ? { select: ctx.select } : undefined);
      if (sharedEnums !== null) files.push({ path: `${SHARED_ENUMS_BASENAME}.ts`, content: sharedEnums });
      return files;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
