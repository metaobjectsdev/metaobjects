// Cross-realm node guards — identify a node by its metamodel `type`, never by
// `instanceof`.
//
// WHY THESE EXIST
//
// `x instanceof MetaSource` is only sound when the class object and the instance
// come from the SAME physical copy of this package. Two copies in one process —
// a globally-installed or linked `meta` CLI alongside a project-local
// dependency — give them different class objects, so `instanceof` returns false
// for a node that is a source in every observable respect. This is the same
// class-identity defect that split ts-poet's `Code` objects in 0.21.6; there it
// was loud (duplicate imports → TS2300), but across the metadata boundary it is
// SILENT: a consumer package reads the node as "not a source" and simply emits
// nothing for it, with no error.
//
// WHO IS EXPOSED
//
// Sites INSIDE this package are immune by construction — a package's own module
// graph resolves its own files, so the class and the instance always match.
// The exposed callers are the OTHER packages that import a class from here
// (`codegen-ts`, `migrate-ts`, `runtime-ts`). `meta gen` / `meta migrate` alias
// `@metaobjectsdev/metadata` to the CLI's own copy (the CLI's
// `load-metaobjects-config.ts` CLI_PKG_PATHS), which closes the split for the
// CLI path — but that alias map does not run when a consumer embeds `runGen()`
// or the migrate engine programmatically, so cross-package code must not depend
// on it. A flat single-tree install also dedupes and hides the split, which is
// why in-process gates do not reproduce it.
//
// WHY TYPE-BASED IDENTIFICATION IS EQUIVALENT
//
// The registry binds one concrete class per metamodel type (TYPE_SOURCE →
// MetaSource, TYPE_OBJECT → MetaObject, TYPE_METADATA → MetaRoot), so on a
// single-copy tree `node.type === TYPE_SOURCE` and `node instanceof MetaSource`
// answer identically — these guards change nothing there. On a split tree the
// type still answers correctly, because `type` is data on the node rather than
// an identity shared with a class object.
//
// The returned predicate narrows to this copy's class type. That is a
// structural assertion, not a claim of instance identity: a foreign-realm node
// carries the same properties and prototype methods, so every member the caller
// then touches resolves. Callers needing behaviour from a node that may be
// foreign should still fail closed if a method is absent.

import { TYPE_FIELD, TYPE_METADATA, TYPE_OBJECT, TYPE_SOURCE } from "./base-types.js";
import type { MetaData } from "./meta-data.js";
import type { MetaRoot } from "./meta-root.js";
import type { MetaObject } from "../core/object/meta-object.js";
import type { MetaField } from "../core/field/meta-field.js";
import type { MetaSource } from "../persistence/source/meta-source.js";

/** The node's metamodel `type`, or undefined when the value is not a node at all. */
function nodeType(node: unknown): string | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  const t = (node as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

/** True when the node is a metadata root (type=metadata), across package copies. */
export function isMetaRoot(node: unknown): node is MetaRoot {
  return nodeType(node) === TYPE_METADATA;
}

/** True when the node is an object node (type=object), across package copies. */
export function isMetaObject(node: unknown): node is MetaObject {
  return nodeType(node) === TYPE_OBJECT;
}

/** True when the node is a field node (type=field), across package copies. */
export function isMetaField(node: unknown): node is MetaField {
  return nodeType(node) === TYPE_FIELD;
}

/** True when the node is a source node (type=source), across package copies. */
export function isMetaSource(node: unknown): node is MetaSource {
  return nodeType(node) === TYPE_SOURCE;
}

/**
 * True when the node is a source that reports itself writable.
 *
 * Reads the writability surface through the node rather than through the class,
 * and fails closed when a foreign node cannot answer — the same outcome the old
 * `instanceof` guard produced for a node it did not recognise.
 */
export function isWritableSource(node: MetaData | undefined): node is MetaSource {
  if (!isMetaSource(node)) return false;
  const probe = node as unknown as { isWritable?: () => boolean };
  return typeof probe.isWritable === "function" && probe.isWritable();
}

/** True when the node is a source that reports itself read-only. See isWritableSource. */
export function isReadOnlySource(node: MetaData | undefined): node is MetaSource {
  if (!isMetaSource(node)) return false;
  const probe = node as unknown as { isReadOnly?: () => boolean };
  return typeof probe.isReadOnly === "function" && probe.isReadOnly();
}
