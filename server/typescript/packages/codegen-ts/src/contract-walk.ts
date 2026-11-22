// What the contract types layer covers (ADR-0067 §1, layer 1), for one model.
//
// Engine, not emit: `contractTypes()` renders these records, and an ejected copy of its renderer
// keeps calling this walk, so which objects carry a contract and how an operation's input and
// output resolve stays packaged while the files' shape is the adopter's.
//
// Covered:
//   - every concrete `object.entity` backed by a store: read, create and update shapes;
//   - every concrete `object.projection`: its read shape;
//   - every `object.value` those shapes or an operation's `@inputRef` / `@outputRef` reach, as the
//     value module the entity generator writes (byte for byte, so the two collapse in one run);
//   - each package's declared operations: input, output and the errors they may answer.
// Not covered: reports (their read rows are the report generators'), abstract objects, and the
// key a derived command or a keyed query takes (the service generator decides its parameters).

import {
  FIELD_ATTR_OBJECT_REF,
  FIELD_SUBTYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_PROJECTION,
  OBJECT_SUBTYPE_VALUE,
  OPERATION_ATTR_ERRORS,
  OPERATION_ATTR_INPUT_REF,
  OPERATION_ATTR_MANY,
  OPERATION_ATTR_OUTPUT_REF,
  OPERATION_SUBTYPE_COMMAND,
  RESERVED_ERROR_CODES,
  TYPE_FIELD,
  effectivePackageOf,
  isMetaObject,
  modelOperations,
  operationTarget,
  refTarget,
  topLevelNodeOf,
  type MetaData,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { relative as posixRelative } from "node:path/posix";
import { SHELL_ERROR_CODES } from "./rules-walk.js";
import { entityOutputPath, packageToPath, type OutputLayout } from "./import-path.js";
import { withExtIfRelative, type ExtStyle } from "./render-context.js";
import { effectivePackage } from "./docs-paths.js";
import { hasAnyRdbSource } from "./source-detect.js";
import { isAbstract } from "./instance-artifacts.js";

export { SHELL_ERROR_CODES };

/** The wire codes the REST contract's transport answers with: the reserved codes the shell does
 *  not (ADR-0066 O5). */
export const CONTRACT_ERROR_CODES = RESERVED_ERROR_CODES.filter((c) => !SHELL_ERROR_CODES.includes(c)) as readonly string[];

/** One declared operation, with its `@inputRef` and `@outputRef` resolved. */
export interface ContractOperation {
  readonly name: string;
  readonly kind: "command" | "query";
  /** The `@inputRef` value object, when declared. */
  readonly input: MetaObject | undefined;
  /** The `@outputRef` entity, projection or value, when declared. */
  readonly output: MetaObject | undefined;
  readonly many: boolean;
  /** The business errors a command declares (`@errors`), in declaration order. */
  readonly errors: readonly string[];
}

/** One package's declared operations. */
export interface ContractPackage {
  /** The package (`acme::shop`), or `""` for a model with none. */
  readonly package: string;
  readonly operations: readonly ContractOperation[];
}

/** The contract types of a model. */
export interface ContractModel {
  /** Entities and projections that get `<Name>.contract.ts`, in model order. */
  readonly objects: readonly MetaObject[];
  /** Value objects the contract reaches, in model order. */
  readonly values: readonly MetaObject[];
  /** Packages with at least one declared operation, sorted by package. */
  readonly packages: readonly ContractPackage[];
}

export interface ContractWalkOpts {
  /** Narrow which objects are covered (a generator's `filter` and `--select`). An operation is
   *  kept when its target entity matches or it has none. */
  readonly matches?: (obj: MetaData) => boolean;
}

function strings(node: MetaData, attr: string): string[] {
  const v = node.attr(attr);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function objectRef(node: MetaData, attr: string): MetaObject | undefined {
  const target = refTarget(node, attr);
  return target !== undefined && isMetaObject(target) ? target : undefined;
}

/** Whether `obj` gets its own `<Name>.contract.ts`. */
export function hasObjectContract(obj: MetaObject): boolean {
  if (isAbstract(obj)) return false;
  if (obj.subType === OBJECT_SUBTYPE_ENTITY) return hasAnyRdbSource(obj);
  return obj.subType === OBJECT_SUBTYPE_PROJECTION;
}

/** The value objects `obj`'s fields reference (`field.object @objectRef`), resolving. */
function referencedValues(obj: MetaData): MetaObject[] {
  const out: MetaObject[] = [];
  for (const f of obj.children()) {
    if (f.type !== TYPE_FIELD || f.subType !== FIELD_SUBTYPE_OBJECT) continue;
    const target = objectRef(f, FIELD_ATTR_OBJECT_REF);
    if (target !== undefined && target.subType === OBJECT_SUBTYPE_VALUE) out.push(target);
  }
  return out;
}

/** The contract types of `root`: which objects get one, the values they reach, and the operations. */
export function contractTypesOf(root: MetaData, opts: ContractWalkOpts = {}): ContractModel {
  const matches = opts.matches ?? (() => true);
  const all = root.children().filter(isMetaObject);
  const objects = all.filter((o) => hasObjectContract(o) && matches(o));

  const packages = new Map<string, ContractOperation[]>();
  // One operation declared identically by two APIs (a versioned API) is one operation (O6).
  const seen = new Set<string>();
  for (const op of modelOperations(root)) {
    const target = operationTarget(op);
    if (target !== undefined && !matches(target)) continue;
    const pkg = effectivePackageOf(topLevelNodeOf(op));
    const id = `${pkg}\u0000${op.name.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = op.subType === OPERATION_SUBTYPE_COMMAND ? "command" : "query";
    const ops = packages.get(pkg) ?? [];
    packages.set(pkg, ops);
    ops.push({
      name: op.name,
      kind,
      input: objectRef(op, OPERATION_ATTR_INPUT_REF),
      output: objectRef(op, OPERATION_ATTR_OUTPUT_REF),
      many: op.attr(OPERATION_ATTR_MANY) === true,
      errors: kind === "command" ? strings(op, OPERATION_ATTR_ERRORS) : [],
    });
  }

  // Every value a covered shape reaches, transitively, so a contract module never imports a value
  // module the run did not write.
  const reached = new Set<MetaObject>();
  const queue: MetaData[] = [...objects];
  const reach = (v: MetaObject | undefined) => {
    if (v === undefined || v.subType !== OBJECT_SUBTYPE_VALUE || reached.has(v)) return;
    reached.add(v);
    queue.push(v);
  };
  for (const ops of packages.values()) {
    for (const o of ops) {
      reach(o.input);
      reach(o.output);
    }
  }
  while (queue.length > 0) for (const v of referencedValues(queue.shift()!)) reach(v);

  return {
    objects,
    values: all.filter((o) => reached.has(o)),
    packages: [...packages.keys()].sort().map((pkg) => ({ package: pkg, operations: packages.get(pkg)! })),
  };
}

/** The suffix of an object's contract module (`Order.contract.ts`). */
export const CONTRACT_FILE_SUFFIX = ".contract.ts";
/** The wire error module, at the target root. */
export const CONTRACT_ERRORS_FILE = "errors.contract.ts";
/** The operations module, one per package that declares operations. */
export const CONTRACT_OPERATIONS_FILE = "operations.contract.ts";

/** Where `obj`'s contract module goes: beside where the entity generator writes `<Name>.ts`. */
export function contractObjectPath(layout: OutputLayout, obj: MetaObject): string {
  return entityOutputPath(layout, effectivePackage(obj), `${obj.name}${CONTRACT_FILE_SUFFIX}`);
}

/** Where a value object's module goes: the entity generator's own path, so the two collapse. */
export function contractValuePath(layout: OutputLayout, obj: MetaObject): string {
  return entityOutputPath(layout, effectivePackage(obj), `${obj.name}.ts`);
}

/** Where a package's operations module goes: under the package's directory in either layout, so
 *  two packages never both write it. */
export function contractOperationsPath(pkg: string): string {
  const dir = packageToPath(pkg);
  return dir === "" ? CONTRACT_OPERATIONS_FILE : `${dir}/${CONTRACT_OPERATIONS_FILE}`;
}

/** The module specifier from the file at `fromFile` to the module file `toFile`, both relative to
 *  the target's outDir. */
export function contractSpecifier(fromFile: string, toFile: string, extStyle: ExtStyle): string {
  const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  let rel = posixRelative(fromDir, toFile.replace(/\.ts$/, ""));
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return withExtIfRelative(rel, extStyle);
}
