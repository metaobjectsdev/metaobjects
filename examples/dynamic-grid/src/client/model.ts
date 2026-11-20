/**
 * The model as the browser reads it: the `/_meta` document, plus where each entity is served.
 *
 * `loadMetaModel` and `buildGrid` from `@metaobjectsdev/runtime-web` do the reading for
 * objects, fields, views and grid layouts. They do not expose identities, validators,
 * relationships or value-object references, which a form needs, so this file reads those
 * from the same document. Everything a component asks about an entity is answered here, from
 * metadata; no component names an entity or a field.
 */
import {
  ATTR_PREFIX,
  CARDINALITY_MANY,
  CHILD_REF_SEPARATOR,
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_VALUES,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  FILTER_OP_EQ,
  GENERATION_ASSIGNED,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_REFERENCE,
  OBJECT_SUBTYPE_VALUE,
  opsForField,
  PACKAGE_SEPARATOR,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_THROUGH,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_NAME,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_OBJECT,
  TYPE_RELATIONSHIP,
  TYPE_SUBTYPE_SEPARATOR,
  TYPE_VALIDATOR,
  VIEW_SUBTYPE_PASSWORD,
  type FilterOp,
} from "@metaobjectsdev/metadata/constants";
import { buildGrid, loadMetaModel, type AttrReader, type MetaFieldRead, type MetaGrid, type MetaRead } from "@metaobjectsdev/runtime-web";
import type { ServedInfo } from "../served";

/** A validator declared under a field: its subtype (`numeric`, `regex`, ...) and attributes. */
export interface ValidatorModel {
  readonly subType: string;
  readonly attr: AttrReader;
}

export interface FieldModel {
  readonly name: string;
  readonly subType: string;
  /** The display label: the humanized field name. */
  readonly label: string;
  readonly attr: AttrReader;
  /** The field's first view, when it declares one: how the author wants it presented. */
  readonly view: { readonly subType: string; readonly attr: AttrReader } | undefined;
  readonly required: boolean;
  /** The operators a list may filter this field with; empty when it is not `@filterable`. */
  readonly filterOps: readonly FilterOp[];
  readonly sortable: boolean;
  /** The members of a `field.enum`; empty for any other field. */
  readonly enumValues: readonly string[];
  readonly validators: readonly ValidatorModel[];
  /** For a `field.object`: the value object it holds. */
  readonly valueObject: ObjectModel | undefined;
  /** For a foreign key: the name of the entity it refers to. */
  readonly references: string | undefined;
  /** True when the field holds a list of values. A cell shows them; the form has no control for one. */
  readonly isArray: boolean;
  /** True for a primary key the database generates: shown, never entered. */
  readonly generated: boolean;
  /**
   * False for a field no request may set: a generated key, a credential (`view.password`)
   * or a field marked `@formExclude`. The server refuses these, so the form does not offer them.
   */
  readonly writable: boolean;
}

export interface ObjectModel {
  readonly name: string;
  readonly label: string;
  readonly fields: readonly FieldModel[];
  field(name: string): FieldModel | undefined;
}

/** A to-many relationship that can be shown as a list: the related rows that point back here. */
export interface RelatedModel {
  /** The relationship's name in the metadata (`lines`, `workOrders`). */
  readonly name: string;
  readonly label: string;
  /** The entity the related rows belong to. */
  readonly entity: string;
  /** The foreign-key field on that entity that points back at this one. */
  readonly via: string;
}

export interface EntityModel extends ObjectModel {
  /** The collection path, relative to the API base URL: `/work_orders`. */
  readonly path: string;
  /** Columns, page size and initial sort, from the entity's `layout.dataGrid`. */
  readonly grid: MetaGrid;
  /** The primary-key field. */
  readonly keyField: string;
  /** The field that names a row to a person: used wherever another entity refers to this one. */
  readonly titleField: string;
  /** The entity's to-many relationships whose related rows can be listed. */
  readonly related: readonly RelatedModel[];
}

export interface ClientModel {
  readonly revision: number;
  /** The served entities, in the order the metadata declares them. */
  readonly entities: readonly EntityModel[];
  entity(name: string): EntityModel | undefined;
  /** The largest page a list may ask for, when the project sets a ceiling. */
  readonly maxLimit: number | undefined;
}

/** camelCase or PascalCase to "Title Case": the same rule the grid headers use. */
export function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// --- the part of the document `MetaRead` does not expose ---------------------------------

interface RawNode {
  readonly type: string;
  readonly subType: string;
  readonly name: string;
  readonly isArray: boolean;
  readonly attr: AttrReader;
  readonly children: readonly RawNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A canonical node is a one-key object: `{ "field.string": { name, "@attr": ..., children } }`. */
function readNode(value: unknown): RawNode | undefined {
  if (!isRecord(value)) return undefined;
  const [key, ...rest] = Object.keys(value);
  const body = key === undefined ? undefined : value[key];
  if (key === undefined || rest.length > 0 || !isRecord(body)) return undefined;
  const at = key.indexOf(TYPE_SUBTYPE_SEPARATOR);
  if (at < 0) return undefined;
  const name = body[RESERVED_KEY_NAME];
  const children = body[RESERVED_KEY_CHILDREN];
  return {
    type: key.slice(0, at),
    subType: key.slice(at + TYPE_SUBTYPE_SEPARATOR.length),
    name: typeof name === "string" ? name : "",
    isArray: body[RESERVED_KEY_IS_ARRAY] === true,
    attr: (attrName) => body[`${ATTR_PREFIX}${attrName}`],
    children: Array.isArray(children) ? children.map(readNode).filter((n): n is RawNode => n !== undefined) : [],
  };
}

/** `demo::workshop::Customer` or `Customer.id` to `Customer`. */
function shortName(ref: unknown): string | undefined {
  if (typeof ref !== "string" || ref === "") return undefined;
  const unqualified = ref.slice(ref.lastIndexOf(PACKAGE_SEPARATOR) + (ref.includes(PACKAGE_SEPARATOR) ? PACKAGE_SEPARATOR.length : 0));
  const member = unqualified.indexOf(CHILD_REF_SEPARATOR);
  return member < 0 ? unqualified : unqualified.slice(0, member);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? [value] : [];
}

// --- building the model ------------------------------------------------------------------

export function buildClientModel(metaDocument: unknown, served: ServedInfo): ClientModel {
  const read = loadMetaModel(metaDocument);
  const rawRoot = readNode(metaDocument);
  const rawObjects = new Map((rawRoot?.children ?? []).filter((n) => n.type === TYPE_OBJECT).map((n) => [n.name, n] as const));
  const objects = new Map<string, ObjectModel>();

  function fieldModel(owner: RawNode | undefined, field: MetaFieldRead): FieldModel {
    const raw = owner?.children.find((n) => n.type === TYPE_FIELD && n.name === field.name);
    const identities = owner?.children.filter((n) => n.type === TYPE_IDENTITY) ?? [];
    const primary = identities.find((n) => n.subType === IDENTITY_SUBTYPE_PRIMARY);
    const reference = identities.find(
      (n) => n.subType === IDENTITY_SUBTYPE_REFERENCE && stringList(n.attr(IDENTITY_ATTR_FIELDS)).includes(field.name),
    );
    const sortable = field.attr(FIELD_ATTR_SORTABLE);
    const filterable = field.attr(FIELD_ATTR_FILTERABLE) === true;
    const view = field.views()[0];
    const valueObjectName = field.subType === FIELD_SUBTYPE_OBJECT ? shortName(field.attr(FIELD_ATTR_OBJECT_REF)) : undefined;
    const generated =
      primary !== undefined &&
      primary.attr(IDENTITY_ATTR_GENERATION) !== GENERATION_ASSIGNED &&
      stringList(primary.attr(IDENTITY_ATTR_FIELDS)).includes(field.name);
    return {
      name: field.name,
      subType: field.subType,
      label: humanize(field.name),
      attr: field.attr,
      view,
      required: field.attr(FIELD_ATTR_REQUIRED) === true,
      // The same function the server derives its allowlist with, so the two cannot disagree.
      filterOps: filterable ? opsForField(field) : [],
      sortable: sortable === true || (sortable !== false && filterable),
      enumValues: stringList(field.attr(FIELD_ATTR_VALUES)),
      validators: (raw?.children ?? []).filter((n) => n.type === TYPE_VALIDATOR),
      valueObject: valueObjectName === undefined ? undefined : objectModel(valueObjectName),
      references: reference === undefined ? undefined : shortName(reference.attr(IDENTITY_REFERENCE_ATTR_REFERENCES)),
      isArray: raw?.isArray === true,
      generated,
      writable: !generated && field.attr(FIELD_ATTR_FORM_EXCLUDE) !== true && !field.views().some((v) => v.subType === VIEW_SUBTYPE_PASSWORD),
    };
  }

  function objectModel(name: string): ObjectModel | undefined {
    const known = objects.get(name);
    if (known !== undefined) return known;
    const object = read.object(name);
    if (object === undefined) return undefined;
    const fields: FieldModel[] = [];
    const model: ObjectModel = {
      name,
      label: humanize(name),
      fields,
      field: (fieldName) => fields.find((f) => f.name === fieldName),
    };
    // Registered before its fields are built, so a value object that holds itself terminates.
    objects.set(name, model);
    for (const field of object.fields()) fields.push(fieldModel(rawObjects.get(name), field));
    return model;
  }

  function entityModel(object: MetaRead, collection: string): EntityModel | undefined {
    const base = objectModel(object.name);
    if (base === undefined) return undefined;
    const key = base.fields.find((f) => f.generated) ?? base.fields[0];
    if (key === undefined) return undefined;
    // A row's title: its first required plain string, which is `name`, `title` or `sku` in
    // every entity here. Read from the metadata, so it follows the model, not this file.
    const title = base.fields.find((f) => f.subType === FIELD_SUBTYPE_STRING && f.required) ?? key;
    return { ...base, path: `/${collection}`, grid: buildGrid(object), keyField: key.name, titleField: title.name, related: [] };
  }

  /**
   * A to-many relationship is listable when the related entity is served and has a foreign
   * key back to this one that a list may filter on with `eq`. Anything else (a many-to-many
   * through a join entity, a relationship to an unserved object) is left out.
   */
  function relatedModels(entity: EntityModel, all: readonly EntityModel[]): RelatedModel[] {
    const related: RelatedModel[] = [];
    for (const node of rawObjects.get(entity.name)?.children ?? []) {
      if (node.type !== TYPE_RELATIONSHIP || node.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
      if (node.attr(RELATIONSHIP_ATTR_THROUGH) !== undefined) continue;
      const target = all.find((e) => e.name === shortName(node.attr(RELATIONSHIP_ATTR_OBJECT_REF)));
      const via = target?.fields.find((f) => f.references === entity.name && f.filterOps.includes(FILTER_OP_EQ));
      if (target !== undefined && via !== undefined) {
        related.push({ name: node.name, label: humanize(node.name), entity: target.name, via: via.name });
      }
    }
    return related;
  }

  const built: EntityModel[] = [];
  for (const object of read.objects()) {
    const collection = served.collections[object.name];
    if (collection === undefined || object.subType === OBJECT_SUBTYPE_VALUE) continue;
    const entity = entityModel(object, collection);
    if (entity !== undefined) built.push(entity);
  }
  // Relationships name other entities, so they are resolved once every entity is built.
  const entities = built.map((entity): EntityModel => ({ ...entity, related: relatedModels(entity, built) }));

  return {
    revision: served.revision,
    entities,
    entity: (name) => entities.find((e) => e.name === name),
    maxLimit: served.pagination?.maxLimit,
  };
}
