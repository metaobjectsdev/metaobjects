// Entity-constants template — emits an `<Entity>` const with all the
// metadata-derived strings consumers should use INSTEAD of magic strings.
//
// Shape (each non-$-prefixed key is a per-field object):
//
//   export const Subscriber = {
//     $entity: "Subscriber",
//     $table:  "subscribers",
//     $path:   "/subscribers",
//
//     email: {
//       name:        "email",
//       label:       "Email Address",      // from @label on the view, falls back to humanized field name
//       view:        "text",                // MetaView subtype
//       htmlType:    "email",               // optional; only when it maps to a real HTML input type
//       placeholder: "you@example.com",     // optional; only when @placeholder is set on the view
//       helpText:    "We never share this.", // optional; only when @helpText is set
//       rules: {                             // optional; derived from validator children
//         required:  "Email is required",
//         maxLength: { value: 255, message: "Must be 255 characters or fewer" },
//         pattern:   { value: /.../, message: "Invalid email" },
//       },
//     },
//     // ...
//   } as const;
//
// Consumers spread `form.input.email` from useEntityForm and never touch
// per-attribute access (placeholder, rules, etc.) by hand — the helper
// picks them up from this object automatically.

import { code, type Code } from "ts-poet";
import type { MetaData } from "@metaobjectsdev/metadata";
import { MetaObject, MetaField } from "@metaobjectsdev/metadata";
import {
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_NUMBER,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_DATE,
  VIEW_SUBTYPE_PASSWORD,
  VIEW_SUBTYPE_HIDDEN,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_RADIO,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  VALIDATOR_ATTR_PATTERN,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_REQUIRED,
} from "@metaobjectsdev/metadata";
import { resolveTableName, pluralize, toSnakeCase } from "@metaobjectsdev/metadata";
import { inferViewKind, currencyMetaFor, labelFor } from "./field-meta.js";

/** Convert a camelCase or PascalCase field name to a human-friendly label. */
function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * REST resource path for an entity. Pluralized + snake_cased + lowercased.
 *   "Subscriber" → "/subscribers"
 *   "WorkoutEvent" → "/workout_events"
 */
export function resourcePath(entity: MetaData): string {
  const overrideAttr = entity.ownAttr("routePath");
  if (typeof overrideAttr === "string" && overrideAttr.length > 0) {
    return overrideAttr.startsWith("/") ? overrideAttr : `/${overrideAttr}`;
  }
  return `/${pluralize(toSnakeCase(entity.name))}`;
}

/** Resolve the view subtype: explicit `view` child (own or inherited) wins, else inferred from field subType. */
function resolveView(field: MetaField): { view: string; viewNode?: MetaData } {
  const viewChild = field.views()[0];
  if (viewChild) {
    return { view: viewChild.subType, viewNode: viewChild };
  }
  return { view: inferViewKind(field) };
}

/**
 * Map a MetaView subtype to a real HTML <input type=...> value. Returns
 * undefined for views that don't map to <input> at all (textarea, dropdown,
 * radio) — consumers render the right element type themselves.
 */
function htmlTypeFromView(view: string, override?: string): string | undefined {
  if (typeof override === "string" && override.length > 0) return override;
  switch (view) {
    case VIEW_SUBTYPE_TEXT:
      return "text";
    case VIEW_SUBTYPE_NUMBER:
      return "number";
    case VIEW_SUBTYPE_DATE:
      return "date";
    case VIEW_SUBTYPE_PASSWORD:
      return "password";
    case VIEW_SUBTYPE_CHECKBOX:
      return "checkbox";
    case VIEW_SUBTYPE_HIDDEN:
      return "hidden";
    case VIEW_SUBTYPE_RADIO:
      return "radio";
    case "month":
      return "month";
    case "email":
      return "email";
    case VIEW_SUBTYPE_TEXTAREA:
    case VIEW_SUBTYPE_DROPDOWN:
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Build RHF rules JSON-ish code from a field's validator children plus
 * field-level attrs (`@required`, `@maxLength`). Returns the code string
 * (e.g. `{ required: "X", maxLength: { value: 255, message: "..." } }`)
 * or undefined when there are no rules to emit.
 */
function renderFieldRules(field: MetaField): string | undefined {
  const ruleParts: string[] = [];

  let hasRequired = false;
  let hasMaxLength = false;

  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) {
      const msg = (child.ownAttr("message") as string | undefined) ?? `${humanize(field.name)} is required`;
      ruleParts.push(`required: ${JSON.stringify(msg)}`);
      hasRequired = true;
    } else if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = child.ownAttr(VALIDATOR_ATTR_MIN);
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") {
        const msg = (child.ownAttr("minMessage") as string | undefined) ?? `Must be at least ${min} characters`;
        ruleParts.push(`minLength: { value: ${min}, message: ${JSON.stringify(msg)} }`);
      }
      if (typeof max === "number") {
        const msg = (child.ownAttr("maxMessage") as string | undefined) ?? `Must be ${max} characters or fewer`;
        ruleParts.push(`maxLength: { value: ${max}, message: ${JSON.stringify(msg)} }`);
        hasMaxLength = true;
      }
    } else if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = child.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string") {
        const msg = (child.ownAttr("message") as string | undefined) ?? "Invalid format";
        // Emit as RegExp literal /.../ — `as const` preserves the value-ref.
        // Forward-slash inside the pattern is escaped so the literal closes correctly.
        const safe = pattern.replace(/\\/g, "\\\\").replace(/\//g, "\\/");
        ruleParts.push(`pattern: { value: /${safe}/, message: ${JSON.stringify(msg)} }`);
      }
    }
  }

  // Field-level @required attr (if not already covered by validator).
  if (!hasRequired && field.ownAttr(FIELD_ATTR_REQUIRED) === true) {
    ruleParts.push(`required: ${JSON.stringify(`${humanize(field.name)} is required`)}`);
  }

  // Field-level @maxLength attr (if not already covered).
  const maxLenAttr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  if (!hasMaxLength && typeof maxLenAttr === "number") {
    ruleParts.push(
      `maxLength: { value: ${maxLenAttr}, message: ${JSON.stringify(`Must be ${maxLenAttr} characters or fewer`)} }`,
    );
  }

  if (ruleParts.length === 0) return undefined;
  return `{ ${ruleParts.join(", ")} }`;
}

/** Build one nested field-object entry like `email: { name, label, ... },`. */
function renderFieldEntry(field: MetaField): string {
  const { view, viewNode } = resolveView(field);
  const label = labelFor(field);
  const placeholder = viewNode?.ownAttr("placeholder") as string | undefined;
  const helpText = viewNode?.ownAttr("helpText") as string | undefined;
  const htmlType = htmlTypeFromView(view, viewNode?.ownAttr("htmlType") as string | undefined);
  const rules = renderFieldRules(field);

  const entries: string[] = [
    `name: ${JSON.stringify(field.name)}`,
    `label: ${JSON.stringify(label)}`,
    `view: ${JSON.stringify(view)}`,
  ];
  if (htmlType !== undefined) entries.push(`htmlType: ${JSON.stringify(htmlType)}`);
  if (placeholder !== undefined) entries.push(`placeholder: ${JSON.stringify(placeholder)}`);
  if (helpText !== undefined) entries.push(`helpText: ${JSON.stringify(helpText)}`);
  if (rules !== undefined) entries.push(`rules: ${rules}`);

  // Currency-specific keys: only emitted for currency-subtype fields.
  const currencyMeta = currencyMetaFor(field);
  if (currencyMeta !== null) {
    entries.push(`currency: ${JSON.stringify(currencyMeta.currency)}`);
    entries.push(`locale: ${JSON.stringify(currencyMeta.locale)}`);
  }

  return `  ${field.name}: {\n    ${entries.join(",\n    ")},\n  }`;
}

export function renderEntityConstants(obj: MetaObject, apiPrefix = ""): Code {
  const entityName = obj.name;
  const tableName = resolveTableName(obj);
  const path = resourcePath(obj);

  const fieldEntries: string[] = [];
  // Use fields() so inherited fields (from extends:/super:) appear in constants.
  for (const child of obj.fields()) {
    fieldEntries.push(renderFieldEntry(child));
  }

  const body = [
    `  $entity: ${JSON.stringify(entityName)}`,
    `  $table: ${JSON.stringify(tableName)}`,
    `  $path: ${JSON.stringify(path)}`,
    `  $apiPrefix: ${JSON.stringify(apiPrefix)}`,
    ...fieldEntries,
  ].join(",\n");

  return code`
/**
 * Metadata constants for ${entityName}.
 *
 * Use these instead of magic strings so TS catches typos and refactors stay
 * coherent. Each non-dollar-prefixed key is a per-field object carrying
 * name, label, view, optional htmlType/placeholder/helpText, and the
 * RHF-shaped validation rules derived from the field's validator children.
 *
 * Typical usage with the metaobjects React form helper:
 *
 *   import { useEntityForm } from '@metaobjectsdev/react';
 *   const form = useEntityForm(${entityName}, ${entityName}InsertSchema);
 *   <input {...form.input.${
    fieldEntries[0]?.match(/^\s*(\w+):/)?.[1] ?? "fieldName"
  }} />
 */
export const ${entityName} = {
${body},
} as const;
`;
}
