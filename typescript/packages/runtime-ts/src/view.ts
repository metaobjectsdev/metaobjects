import type { MetaData } from "@metaobjects/metadata";
import {
  TYPE_FIELD, TYPE_VIEW, TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED,
  FIELD_ATTR_REQUIRED,
} from "@metaobjects/metadata";
import { MetadataError } from "./errors.js";

export interface FieldViewSpec {
  fieldName: string;
  fieldSubType: string;
  viewName: string;
  /** The view node's subType (e.g., "text", "number", "select"). */
  controlType: string;
  attrs: Record<string, unknown>;
  required?: boolean;
}

export interface EntityViewSpec {
  entityName: string;
  viewName: string;
  fields: FieldViewSpec[];
}

export function viewFieldNames(entity: MetaData, viewName: string): string[] {
  const names: string[] = [];
  for (const field of entity.children()) {
    if (field.type !== TYPE_FIELD) continue;
    if (field.children().some((c) => c.type === TYPE_VIEW && c.name === viewName)) {
      names.push(field.name);
    }
  }
  return names;
}

export function fieldViewSpec(entity: MetaData, fieldName: string, viewName: string): FieldViewSpec | null {
  const field = entity.children().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) return null;
  const view = field.children().find((c) => c.type === TYPE_VIEW && c.name === viewName);
  if (!view) return null;

  const attrs: Record<string, unknown> = {};
  for (const key of view.attrs().keys()) {
    attrs[key] = view.attr(key);
  }

  const required = isFieldRequired(field);

  const result: FieldViewSpec = {
    fieldName: field.name,
    fieldSubType: field.subType,
    viewName,
    controlType: view.subType,
    attrs,
  };
  if (required) result.required = true;
  return result;
}

export function entityViewSpec(entity: MetaData, viewName: string): EntityViewSpec {
  const fields: FieldViewSpec[] = [];
  for (const field of entity.children()) {
    if (field.type !== TYPE_FIELD) continue;
    const spec = fieldViewSpec(entity, field.name, viewName);
    if (spec !== null) fields.push(spec);
  }
  if (fields.length === 0) {
    throw new MetadataError(
      `No fields tagged with view '${viewName}' on entity '${entity.name}'`,
      { entity: entity.name },
    );
  }
  return { entityName: entity.name, viewName, fields };
}

function isFieldRequired(field: MetaData): boolean {
  if (field.attr(FIELD_ATTR_REQUIRED) === true) return true;
  for (const child of field.children()) {
    if (child.type === TYPE_VALIDATOR && child.subType === VALIDATOR_SUBTYPE_REQUIRED) return true;
  }
  return false;
}
