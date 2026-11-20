/**
 * Three checks on a write body that the generated Zod schemas make and ObjectManager's
 * `runValidators` does not: an enum value must be a declared member, a date must be a real
 * calendar date, and a value object may carry only the members its definition declares.
 *
 * Without these the first two still fail, but late and vaguely: the database's CHECK
 * constraint refuses the enum (`constraint_violation`), and a malformed date is stored as
 * text. The third does not fail at all: an undeclared member is written into the JSON
 * column. All three are read from the loaded metadata, like everything else here.
 */
import {
  FIELD_ATTR_OBJECT_REF,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  isMetaObject,
  OBJECT_SUBTYPE_VALUE,
  refTarget,
  type MetaField,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { enumMembers, readDate } from "./list-query";

/** One problem with a write, in the shape the `validation` 400 lists them. */
export interface WriteIssue {
  readonly path: readonly string[];
  readonly code: string;
  readonly message: string;
}

const CODE_ENUM = "enum";
const CODE_DATE = "date";
const CODE_UNKNOWN_MEMBER = "unknown_member";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value object a `field.object` holds, when its `@objectRef` names one. */
export function valueObjectOf(field: MetaField): MetaObject | undefined {
  if (field.subType !== FIELD_SUBTYPE_OBJECT) return undefined;
  const target = refTarget(field, FIELD_ATTR_OBJECT_REF);
  return target !== undefined && isMetaObject(target) && target.subType === OBJECT_SUBTYPE_VALUE ? target : undefined;
}

/** The issues with the values in `body`, a row of `object` (an entity or a value object). */
export function declaredValueIssues(
  object: MetaObject,
  body: Readonly<Record<string, unknown>>,
  under: readonly string[] = [],
): WriteIssue[] {
  const issues: WriteIssue[] = [];
  for (const [name, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    const path = [...under, name];
    const field = object.findField(name);
    if (field === undefined) {
      // The top level was already checked against the entity; this is a value object's member.
      issues.push({ path, code: CODE_UNKNOWN_MEMBER, message: `${object.name} has no member '${name}'.` });
      continue;
    }
    if (field.subType === FIELD_SUBTYPE_ENUM && !enumMembers(field).includes(String(value))) {
      issues.push({ path, code: CODE_ENUM, message: `'${name}' must be one of ${enumMembers(field).join(", ")}.` });
    } else if (field.subType === FIELD_SUBTYPE_DATE && (typeof value !== "string" || readDate(value) === undefined)) {
      issues.push({ path, code: CODE_DATE, message: `'${name}' must be a date (YYYY-MM-DD).` });
    } else if (isRecord(value)) {
      const valueObject = valueObjectOf(field);
      if (valueObject !== undefined) issues.push(...declaredValueIssues(valueObject, value, path));
    }
  }
  return issues;
}
