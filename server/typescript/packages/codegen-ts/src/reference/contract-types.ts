// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/contract-types.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { contractTypes } from "./codegen/generators/contract-types.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; use `node:` builtins instead.
// targets:       the emit step. Replace the renderers in `../templates/contract-types.js` to change
//                a module's SHAPE (interfaces instead of Zod, one file per package); keep
//                `contractTypesOf` so which objects, values and operations are covered stays the
//                packaged walk.
// use-when:      a transport, a client, a job or another service needs the shapes a service takes
//                and returns, and the wire errors it answers with, without importing the ORM.
// emits:         <Entity>.contract.ts (read, create and update shapes), <Projection>.contract.ts
//                (read shape), the value modules they reach, enums.ts, errors.contract.ts at the
//                target root, and <pkg path>/operations.contract.ts per package that declares
//                operations. A model with no store-backed entity, projection or operation gets
//                no file.
// customize:     swap the renderers; route the layer to its own package with `target`.
// composes-with: entity.ts (its value modules and enums.ts are byte-identical, so the two collapse
//                into one file in one run). Nothing else imports it yet.
//
// A SEPARATE generator, never a branch inside the entity generator: a project that does not list
// it sees no change (fixtures/codegen-noop/rules).
import {
  CONTRACT_ERRORS_FILE,
  DEFAULT_OUTPUT_LAYOUT,
  claimModuleNames,
  contractObjectPath,
  contractOperationsPath,
  contractSpecifier,
  contractTypesOf,
  contractValuePath,
  hasObjectContract,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderValueObjectFile } from "../templates/value-object-file.js";
import { renderSharedEnumsFile, SHARED_ENUMS_BASENAME } from "../templates/enums-file.js";
import {
  renderErrorsContract,
  renderObjectContract,
  renderOperationsContract,
  type ContractShapeRef,
} from "../templates/contract-types.js";
import { isMetaObject, OBJECT_SUBTYPE_VALUE, type MetaData, type MetaObject } from "@metaobjectsdev/metadata";

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
