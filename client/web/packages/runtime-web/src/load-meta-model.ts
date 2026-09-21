// UI-2 — read the `GET /_meta` document into a model buildGrid can walk.
//
// Deliberately NOT the metadata loader: that package's root barrel exports
// MetaDataLoader, which transitively imports `node:url`, so it cannot be bundled
// for a browser (#287). This is a reader over an already-validated, already-
// resolved document — no validation, no registry, no super-resolution.
//
// #287: metamodel VALUES come from the browser-safe constants subpath, never the
// package root — see grid-from-metadata.ts for the full story. The type imports
// below are fine on the root: `import type` is erased at build time.
import {
  TYPE_FIELD, TYPE_LAYOUT, TYPE_VIEW, TYPE_OBJECT,
  ATTR_PREFIX, RESERVED_KEY_NAME, RESERVED_KEY_CHILDREN, TYPE_SUBTYPE_SEPARATOR,
} from "@metaobjectsdev/metadata/constants";
import type {
  AttrReader, MetaFieldRead, MetaLayoutRead, MetaModelRead, MetaRead, MetaViewRead,
} from "./meta-read.js";

/** One parsed node: its fused "type.subType" key and its body. */
interface RawNode {
  type: string;
  subType: string;
  body: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A canonical node is a single-key object: { "field.string": { ... } }. */
function readNode(value: unknown): RawNode | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) return undefined;
  const fused = keys[0]!;
  const body = value[fused];
  if (!isRecord(body)) return undefined;
  const sep = fused.indexOf(TYPE_SUBTYPE_SEPARATOR);
  if (sep < 0) return undefined;
  return { type: fused.slice(0, sep), subType: fused.slice(sep + TYPE_SUBTYPE_SEPARATOR.length), body };
}

function childrenOf(node: RawNode): RawNode[] {
  const raw = node.body[RESERVED_KEY_CHILDREN];
  if (!Array.isArray(raw)) return [];
  const out: RawNode[] = [];
  for (const entry of raw) {
    const child = readNode(entry);
    if (child !== undefined) out.push(child);
  }
  return out;
}

/**
 * Attributes are the `@`-prefixed body keys, read without the prefix.
 *
 * Every OTHER body key — `name`, `package`, `children`, and — the trap — `extends`
 * — is structural and is excluded here by construction (it never starts with
 * `ATTR_PREFIX`), not by naming and skipping it. The effective document still
 * carries `extends`, with the members it once referenced already inlined
 * elsewhere in the body; this reader never follows it, so nothing is resolved
 * and nothing is double-counted.
 */
function attrReaderFor(node: RawNode): AttrReader {
  const attrs = new Map<string, unknown>();
  for (const [key, value] of Object.entries(node.body)) {
    if (key.startsWith(ATTR_PREFIX)) attrs.set(key.slice(ATTR_PREFIX.length), value);
  }
  return (name: string) => attrs.get(name);
}

function nameOf(node: RawNode): string {
  const raw = node.body[RESERVED_KEY_NAME];
  return typeof raw === "string" ? raw : "";
}

function toView(node: RawNode): MetaViewRead {
  return { subType: node.subType, attr: attrReaderFor(node) };
}

function toField(node: RawNode): MetaFieldRead {
  const views = childrenOf(node).filter((c) => c.type === TYPE_VIEW).map(toView);
  return {
    name: nameOf(node),
    subType: node.subType,
    attr: attrReaderFor(node),
    views: () => views,
  };
}

function toLayout(node: RawNode): MetaLayoutRead {
  return { name: nameOf(node), subType: node.subType, attr: attrReaderFor(node) };
}

function toObject(node: RawNode): MetaRead {
  const kids = childrenOf(node);
  const fields = kids.filter((c) => c.type === TYPE_FIELD).map(toField);
  const layouts = kids.filter((c) => c.type === TYPE_LAYOUT).map(toLayout);
  return {
    name: nameOf(node),
    subType: node.subType,
    attr: attrReaderFor(node),
    fields: () => fields,
    layouts: () => layouts,
  };
}

/**
 * Read a `GET /_meta` document (effective canonical JSON) into a browser model.
 *
 * Accepts the raw response text or an already-parsed value. The document is
 * assumed valid: the server loaded and validated it, and serving the EFFECTIVE
 * form means every inherited member is already materialized here — so `extends`
 * is deliberately never followed (see attrReaderFor).
 */
export function loadMetaModel(json: string | unknown): MetaModelRead {
  const parsed: unknown = typeof json === "string" ? JSON.parse(json) : json;
  const root = readNode(parsed);
  const objects = root === undefined
    ? []
    : childrenOf(root).filter((c) => c.type === TYPE_OBJECT).map(toObject);
  const byName = new Map(objects.map((o) => [o.name, o] as const));
  return {
    objects: () => objects,
    object: (name: string) => byName.get(name),
  };
}
