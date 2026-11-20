/**
 * What a form control holds, and how it becomes a request body.
 *
 * Which control a field gets, what an empty control means and how its text becomes a typed
 * value are all decided from the field's metadata. Nothing here knows an entity or a field
 * by name. Validation is NOT re-implemented here: the server runs the model's validators
 * and this form shows what it answers. The one check made before sending is "a required
 * field is empty", which needs no round trip.
 */
import {
  FIELD_ATTR_DEFAULT,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
  VIEW_SUBTYPE_TEXTAREA,
} from "@metaobjectsdev/metadata/constants";
import type { Row } from "./api";
import { isRecord, type FieldModel, type ObjectModel } from "./model";

/** The kinds of control this form can draw. */
export const CONTROL_KINDS = [
  "text", "textarea", "integer", "number", "decimal", "date", "checkbox", "select", "reference", "currency", "group",
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** The control for each field subtype this form edits. A subtype not here gets no control. */
const CONTROL_BY_SUBTYPE: Readonly<Record<string, ControlKind>> = {
  [FIELD_SUBTYPE_STRING]: "text",
  [FIELD_SUBTYPE_INT]: "integer",
  [FIELD_SUBTYPE_LONG]: "integer",
  [FIELD_SUBTYPE_DOUBLE]: "number",
  [FIELD_SUBTYPE_FLOAT]: "number",
  [FIELD_SUBTYPE_DECIMAL]: "decimal",
  [FIELD_SUBTYPE_CURRENCY]: "currency",
  [FIELD_SUBTYPE_BOOLEAN]: "checkbox",
  [FIELD_SUBTYPE_DATE]: "date",
  [FIELD_SUBTYPE_ENUM]: "select",
};

/**
 * The control a field is edited with, or undefined when this form has none for it (the
 * form then says so beside the field, and leaves it out of what it sends).
 */
export function controlFor(field: FieldModel): ControlKind | undefined {
  // No list editor is built: a field holding several values has no control.
  if (field.isArray) return undefined;
  // A foreign key is picked from the rows it may point at, whatever type the key is.
  if (field.references !== undefined) return "reference";
  if (field.subType === FIELD_SUBTYPE_OBJECT) return field.valueObject === undefined ? undefined : "group";
  if (field.subType === FIELD_SUBTYPE_STRING && field.view?.subType === VIEW_SUBTYPE_TEXTAREA) return "textarea";
  return CONTROL_BY_SUBTYPE[field.subType];
}

/** What a control holds: text for most, a flag for a checkbox, minor units for money, members for a group. */
export type FormValue = string | boolean | number | null | FormValues;
export interface FormValues {
  readonly [field: string]: FormValue;
}

/** The fields of `object` a person edits: the ones a request may set. */
export function editableFields(object: ObjectModel): readonly FieldModel[] {
  return object.fields.filter((field) => field.writable);
}

/** A stored value as its control holds it. */
function toFormValue(field: FieldModel, stored: unknown): FormValue {
  switch (controlFor(field)) {
    case "checkbox":
      return stored === true;
    case "currency":
      return typeof stored === "number" ? stored : null;
    case "group":
      return field.valueObject === undefined ? null : toFormValues(field.valueObject, isRecord(stored) ? stored : {});
    default:
      return stored === null || stored === undefined ? "" : String(stored);
  }
}

/** A stored row (or `{}` for a new one) as the form holds it. */
export function toFormValues(object: ObjectModel, row: Row): FormValues {
  return Object.fromEntries(editableFields(object).map((field) => [field.name, toFormValue(field, row[field.name])]));
}

/** A new row's starting values: each field's `@default` where the model declares one. */
export function newFormValues(object: ObjectModel): FormValues {
  const defaults: Row = {};
  for (const field of editableFields(object)) {
    const declared = field.attr(FIELD_ATTR_DEFAULT);
    if (declared !== undefined) defaults[field.name] = declared;
  }
  return toFormValues(object, defaults);
}

/** A problem found before sending, in the shape the server reports its own: a path and a message. */
export interface FormIssue {
  readonly path: string;
  readonly message: string;
}

const WHOLE_NUMBER = /^-?\d+$/;
const DECIMAL_NUMBER = /^-?\d+(\.\d+)?$/;

/** What `toWire` answers: the value to send (null for an empty control), or why there is none. */
type Wire = { readonly value: unknown } | { readonly problem: string };

function textToWire(kind: ControlKind, text: string): Wire {
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  switch (kind) {
    case "integer": {
      const n = WHOLE_NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
      return Number.isSafeInteger(n) ? { value: n } : { problem: "Enter a whole number." };
    }
    case "number": {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { value: n } : { problem: "Enter a number." };
    }
    case "decimal":
      // Kept as the digits typed: a decimal goes to the server as text, never through a double.
      return DECIMAL_NUMBER.test(trimmed) ? { value: trimmed } : { problem: "Enter a decimal number, like 12.50." };
    default:
      return { value: kind === "text" || kind === "textarea" ? text : trimmed };
  }
}

/**
 * The request body for what the form holds, and the problems that stop it being sent.
 *
 * A field is in the body when it has a value, or when `stored` is given (an edit) and the
 * value differs from the stored one, in which case an emptied control sends `null`. A
 * create therefore leaves empty fields out, and the database applies their defaults.
 */
export function toBody(
  object: ObjectModel,
  values: FormValues,
  stored: Row | undefined,
): { readonly body: Row; readonly issues: readonly FormIssue[] } {
  const body: Row = {};
  const issues: FormIssue[] = [];
  for (const field of editableFields(object)) {
    const kind = controlFor(field);
    if (kind === undefined) continue;
    const held = values[field.name];
    let value: unknown;
    if (kind === "group") {
      const members = field.valueObject;
      if (members === undefined) continue;
      const inner = toBody(members, isRecord(held) ? (held as FormValues) : {}, undefined);
      // A value object with every member empty is no value object at all.
      const empty = Object.keys(inner.body).length === 0;
      value = empty ? null : inner.body;
      if (!empty) issues.push(...inner.issues.map((issue) => ({ ...issue, path: `${field.name}.${issue.path}` })));
    } else if (kind === "checkbox") {
      value = held === true;
    } else if (kind === "currency") {
      // The money box shows 0.00 until somebody edits it. A new row's required amount left
      // there is sent as the 0 it shows; an optional one, and an edit's, is left alone.
      value = typeof held === "number" ? held : stored === undefined && field.required ? 0 : null;
    } else {
      // A foreign key is typed by its own field, not by the picker it is shown as.
      const wire = textToWire(kind === "reference" ? (CONTROL_BY_SUBTYPE[field.subType] ?? "text") : kind, typeof held === "string" ? held : "");
      if ("problem" in wire) {
        issues.push({ path: field.name, message: wire.problem });
        continue;
      }
      value = wire.value;
    }
    if (value === null && field.required) {
      issues.push({ path: field.name, message: `${field.label} is required.` });
      continue;
    }
    if (stored === undefined) {
      if (value !== null) body[field.name] = value;
    } else if (JSON.stringify(value) !== JSON.stringify(stored[field.name] ?? null)) {
      body[field.name] = value;
    }
  }
  return { body, issues };
}
