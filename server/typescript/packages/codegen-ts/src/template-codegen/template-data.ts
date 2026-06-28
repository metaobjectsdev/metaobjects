// The NEUTRAL, structural codegen template data dict (SP-1 §3.2). Distinct from
// the Markdown-flavored EntityDocData — this carries raw structural facts only,
// so a consumer's Mustache template can emit any language's code from it. The
// field names here are a byte-gated cross-port contract; change them only via the
// spec (and the conformance corpus).
import type { MetaObject, MetaRoot, MetaField } from "@metaobjectsdev/metadata";
import { FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM } from "@metaobjectsdev/metadata";

export interface FieldTemplateData {
  name: string;
  /** Neutral field subtype, e.g. "string" | "int" | "currency" | "enum".
   *  Arrayness is carried by `isArray`, NOT appended here. */
  type: string;
  required: boolean;
  isArray: boolean;
  maxLength?: number;
  enumValues?: string[];
}
export interface IdentityTemplateData { kind: string; fields: string[]; }
export interface RelationshipTemplateData { name: string; cardinality: string; targetRef: string; }
export interface EntityTemplateData {
  name: string;
  package: string;
  fields: FieldTemplateData[];
  identities: IdentityTemplateData[];
  relationships: RelationshipTemplateData[];
}
export interface PackageTemplateData { package: string; entities: EntityTemplateData[]; }
export interface ModelTemplateData { packages: PackageTemplateData[]; }

function fieldData(field: MetaField): FieldTemplateData {
  const d: FieldTemplateData = {
    name: field.name,
    type: field.subType,
    required: field.isRequired,
    isArray: field.isArray === true,
  };
  if (typeof field.maxLength === "number") d.maxLength = field.maxLength;
  if (field.subType === FIELD_SUBTYPE_ENUM) {
    const vals = field.attr(FIELD_ATTR_VALUES);
    if (Array.isArray(vals)) d.enumValues = vals.map((v) => String(v));
  }
  return d;
}

export function buildEntityTemplateData(entity: MetaObject): EntityTemplateData {
  return {
    name: entity.name,
    package: entity.package ?? "",
    fields: entity.fields().map(fieldData),
    identities: entity.identities().map((i) => ({ kind: i.subType, fields: [...i.fields] })),
    relationships: entity.relationships().map((r) => ({
      name: r.name,
      cardinality: r.cardinality ?? "",
      targetRef: r.objectRef ?? "",
    })),
  };
}

export function buildPackageTemplateData(pkg: string, entities: MetaObject[]): PackageTemplateData {
  return { package: pkg, entities: entities.map(buildEntityTemplateData) };
}

/** Groups concrete (non-abstract) objects by package — packages ascending,
 *  entities in `root.objects()` order. Abstract objects never emit instance
 *  artifacts, so they are excluded. */
export function buildModelTemplateData(root: MetaRoot): ModelTemplateData {
  const concrete = root.objects().filter((o) => o.isAbstract !== true);
  const byPkg = new Map<string, MetaObject[]>();
  for (const o of concrete) {
    const pkg = o.package ?? "";
    let bucket = byPkg.get(pkg);
    if (bucket === undefined) { bucket = []; byPkg.set(pkg, bucket); }
    bucket.push(o);
  }
  return {
    packages: [...byPkg.keys()].sort().map((pkg) => buildPackageTemplateData(pkg, byPkg.get(pkg)!)),
  };
}
