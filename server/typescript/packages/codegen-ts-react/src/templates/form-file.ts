// React form template — emits a per-entity Form component that delegates
// to useEntityForm from @metaobjectsdev/react. Each visible field is
// dispatched to a control by its declared view kind.
//
// What gets emitted:
//   - A `<EntityName>Form` component. A plain scalar field (no view kind)
//     spreads form.input.<field> onto a typed <input> (carries aria-label
//     via useEntityForm's `.input` accessor). A field with a view kind
//     (view.textarea/checkbox/radio, or an enum defaulting to a dropdown)
//     is dispatched by fieldControlFor to a <select>/<textarea>/checkbox
//     <input>/radio <fieldset>, bound via `{...form.register("<name>")}`
//     and given a matching explicit `aria-label`.
//   - Per-entity onSubmit/defaultValues typed against the Row type.
//
// Fields excluded from the form by default:
//   - Primary-identity fields (DB-generated)
//   - Fields with @formExclude: true on the metadata
//   - Fields auto-defaulted to CURRENT_TIMESTAMP at the DB
//
// Form generation is OPT-IN per entity via `@emitForm: true` on the
// object metadata. Default off. Most projects don't need stock forms.

import { code, imp } from "ts-poet";
import { MetaField, MetaObject, MetaView, stripPackage } from "@metaobjectsdev/metadata";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DEFAULT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_OBJECT_REF,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_REQUIRED,
  FIELD_SUBTYPE_ENUM,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_RADIO,
  VIEW_SUBTYPE_IMAGE,
  VIEW_TEXTAREA_ATTR_ROWS,
  VIEW_IMAGE_ATTR_ASPECT_RATIO,
  VIEW_IMAGE_ATTR_MAX_EDGE,
  VIEW_IMAGE_ATTR_STORE,
  VIEW_IMAGE_ATTR_ACCEPT,
  VIEW_IMAGE_ATTR_MAX_BYTES,
} from "@metaobjectsdev/metadata";
import { type RenderContext, entityModuleSpecifier, GENERATED_HEADER, tphDiscriminatorPin } from "@metaobjectsdev/codegen-ts";

function primaryFieldNames(entity: MetaObject): Set<string> {
  const set = new Set<string>();
  // identities() returns effective identities, so inherited identities (from extends:/super:) are included.
  for (const child of entity.identities()) {
    if (child.subType !== IDENTITY_SUBTYPE_PRIMARY) continue;
    // ADR-0039: resolving — an identity may inherit @fields via extends.
    const fields = child.attr(IDENTITY_ATTR_FIELDS);
    const fieldsList = Array.isArray(fields) ? fields : (typeof fields === "string" ? [fields] : []);
    for (const f of fieldsList) if (typeof f === "string") set.add(f);
  }
  return set;
}

function isAutoManaged(field: MetaField): boolean {
  // ADR-0039: resolving — a field may inherit @default via extends.
  const def = field.attr(FIELD_ATTR_DEFAULT);
  if (typeof def === "string") {
    const upper = def.toUpperCase();
    if (upper === "CURRENT_TIMESTAMP" || upper === "NOW" || upper === "NOW()") return true;
  }
  return false;
}

/** Visible form fields = all fields minus PK, DB-auto-defaulted, and (for a TPH
 *  subtype) the discriminator — which is implicit (the form is subtype-specific)
 *  and injected server-side, never rendered. */
function visibleFields(entity: MetaObject, discField?: string): MetaField[] {
  const pkNames = primaryFieldNames(entity);
  const out: MetaField[] = [];
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in forms.
  for (const child of entity.fields()) {
    // ADR-0039: resolving — a field may inherit @formExclude via extends.
    if (child.attr(FIELD_ATTR_FORM_EXCLUDE) === true) continue;
    if (pkNames.has(child.name)) continue;
    if (isAutoManaged(child)) continue;
    if (discField !== undefined && child.name === discField) continue;
    out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nested value-object sub-forms (issue #95)
// ---------------------------------------------------------------------------

/** Max recursion depth for nested value objects — a backstop alongside the
 *  per-branch visited-set cycle guard. */
const MAX_VO_DEPTH = 5;

/** Resolve a `field.object`'s `@objectRef` to the referenced value object from
 *  the loaded root. Mirrors the resolution the Zod / inferred-type templates use
 *  (read `@objectRef`, strip the package, look the bare name up on the root). */
function resolveValueObject(field: MetaField, ctx: RenderContext): MetaObject | undefined {
  if (field.subType !== FIELD_SUBTYPE_OBJECT) return undefined;
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  const base = stripPackage(ref);
  return ctx.loadedRoot.objects().find((o) => o.name === base) as MetaObject | undefined;
}

/** camelCase / PascalCase → human label ("llmConfig" → "Llm Config"). */
function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** A real HTML <input type=...> for a scalar field subtype, or undefined (text). */
function htmlTypeForSubType(subType: string): string | undefined {
  switch (subType) {
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
    case FIELD_SUBTYPE_DECIMAL:
    case FIELD_SUBTYPE_CURRENCY:
      return "number";
    case FIELD_SUBTYPE_BOOLEAN:
      return "checkbox";
    case FIELD_SUBTYPE_DATE:
      return "date";
    case FIELD_SUBTYPE_TIME:
      return "time";
    case FIELD_SUBTYPE_TIMESTAMP:
      return "datetime-local";
    default:
      return undefined;
  }
}

/** The react-hook-form `register(...)` argument for a nested field path. A
 *  static path is a plain string literal; a path threaded through an array
 *  element carries a runtime `${index}` and must be a template literal. */
function registerArg(path: string, dynamic: boolean): string {
  return dynamic ? `\`${path}\`` : JSON.stringify(path);
}

/** A stable, identifier-safe useFieldArray hook variable for a static path. */
function arrayHookVar(path: string): string {
  return `${path.replace(/[^A-Za-z0-9]+/g, "_")}Array`;
}

interface FieldRender {
  jsx: string;
  /** useFieldArray declarations to hoist to the top of the component. */
  hooks: string[];
}

/**
 * Render one NESTED field inside a value-object sub-form. Dispatches on subtype:
 *  - a resolvable `field.object` (single) → a nested <fieldset> recursing into
 *    the value object's fields;
 *  - a resolvable `field.object` array → a useFieldArray repeatable group (when
 *    the path is static) or a degraded element-shape fieldset + TODO (when the
 *    path is already inside an array element, i.e. dynamic);
 *  - anything else → a single <input> bound via a nested react-hook-form path.
 */
function renderNestedField(
  field: MetaField,
  path: string,
  dynamic: boolean,
  ctx: RenderContext,
  visited: Set<string>,
  depth: number,
): FieldRender {
  const vo = resolveValueObject(field, ctx);
  if (vo === undefined) {
    // Scalar / enum / unresolved object → a single bound input.
    const htmlType = htmlTypeForSubType(field.subType);
    const typeAttr = htmlType !== undefined ? ` type=${JSON.stringify(htmlType)}` : "";
    return {
      jsx: `<div className="metaobjects-field" key=${JSON.stringify(path)}>
  <label className="metaobjects-field-label">${humanize(field.name)}</label>
  <input className="metaobjects-field-input"${typeAttr} {...form.register(${registerArg(path, dynamic)})} />
</div>`,
      hooks: [],
    };
  }

  const voKey = vo.fqn();
  if (visited.has(voKey) || depth >= MAX_VO_DEPTH) {
    // Cycle or too deep — emit a labeled shell + TODO instead of a flat input.
    return {
      jsx: `<fieldset className="metaobjects-fieldset" key=${JSON.stringify(path)}>
  <legend className="metaobjects-fieldset-legend">${humanize(field.name)}</legend>
  {/* TODO(#95): nested value object ${vo.name} not expanded (recursion guard). Author this sub-form by hand. */}
</fieldset>`,
      hooks: [],
    };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(voKey);

  if (!field.resolvedIsArray()) {
    // Single nested value object → a fieldset recursing into its fields.
    const inner: string[] = [];
    const hooks: string[] = [];
    for (const sub of vo.fields()) {
      const r = renderNestedField(sub, `${path}.${sub.name}`, dynamic, ctx, nextVisited, depth + 1);
      inner.push(r.jsx);
      hooks.push(...r.hooks);
    }
    return {
      jsx: `<fieldset className="metaobjects-fieldset" key=${JSON.stringify(path)}>
  <legend className="metaobjects-fieldset-legend">${humanize(field.name)}</legend>
${inner.join("\n")}
</fieldset>`,
      hooks,
    };
  }

  // Array of value objects.
  if (dynamic) {
    // Already inside an array element — a static useFieldArray name is impossible.
    // Degrade to the element shape + a single clear TODO (never a flat input).
    return {
      jsx: `<fieldset className="metaobjects-fieldset" key=${JSON.stringify(path)}>
  <legend className="metaobjects-fieldset-legend">${humanize(field.name)}</legend>
  {/* TODO(#95): arrays of value objects nested inside another array are not auto-wired
      (the react-hook-form path is dynamic). Render this repeatable group by hand. */}
</fieldset>`,
      hooks: [],
    };
  }

  // Static path → a useFieldArray-based repeatable group.
  const hookVar = arrayHookVar(path);
  const elementPath = `${path}.\${index}`;
  const inner: string[] = [];
  const hooks: string[] = [`const ${hookVar} = useFieldArray({ control: form.control, name: ${JSON.stringify(path)} as never });`];
  for (const sub of vo.fields()) {
    const r = renderNestedField(sub, `${elementPath}.${sub.name}`, true, ctx, nextVisited, depth + 1);
    inner.push(r.jsx);
    hooks.push(...r.hooks);
  }
  const label = humanize(field.name);
  const itemLabel = humanize(vo.name);
  return {
    jsx: `<div className="metaobjects-field-array" key=${JSON.stringify(path)}>
  <span className="metaobjects-field-array-label">${label}</span>
  {${hookVar}.fields.map((item, index) => (
    <fieldset className="metaobjects-fieldset" key={item.id}>
      <legend className="metaobjects-fieldset-legend">${itemLabel} {index + 1}</legend>
${inner.join("\n")}
      <button type="button" className="metaobjects-field-array-remove" onClick={() => ${hookVar}.remove(index)}>
        Remove
      </button>
    </fieldset>
  ))}
  <button type="button" className="metaobjects-field-array-add" onClick={() => ${hookVar}.append({} as never)}>
    Add ${itemLabel}
  </button>
</div>`,
    hooks,
  };
}

/** The view kind that drives control selection: an explicit view child wins;
 *  an enum with no view defaults to a dropdown; otherwise null (typed <input>).
 *  Takes the already-resolved view (callers that also need view attrs, like
 *  the textarea `@rows` lookup, fetch it once via `field.views()[0]` and
 *  pass it through rather than re-deriving it here). */
function viewKindFor(field: MetaField, view: MetaView | undefined): string | null {
  if (view !== undefined) return view.subType;
  if (field.subType === FIELD_SUBTYPE_ENUM) return VIEW_SUBTYPE_DROPDOWN;
  return null;
}

/** The field's declared @values (enum member symbols), or [] when absent. */
function enumValues(field: MetaField): string[] {
  return (field.attr(FIELD_ATTR_VALUES) as string[] | undefined) ?? [];
}

/**
 * Fields whose control can submit `""` for "the user left it blank" (#223).
 *
 * An HTML control has no way to distinguish "empty" from "not provided" — a blank text,
 * date or number input, an unselected `<option value="">`, and an empty textarea all
 * yield the empty string. For a nullable date/timestamp column that is not a value at
 * all (it fails the column's type), and for every other nullable column it makes a
 * `!= null` check read a blank field as SET.
 *
 * Excluded because they cannot produce `""`, and naming one anyway would be a claim about
 * a control that does not exist:
 *   - a checkbox — always a boolean, and `false` is a real answer, never "blank";
 *   - a `view.image` — Controller-managed, and its value is an opaque storage key;
 *   - a nested `field.object` and any array field — rendered as a nested block or a
 *     `useFieldArray` list, so what they submit is an object or an array.
 * A `@required` field is excluded too: blank there is a validation error the schema
 * already owns, and rewriting it would turn a caught error into a silent null.
 */
function blankableOptionalFields(fields: readonly MetaField[]): string[] {
  return fields
    .filter((f) => f.attr(FIELD_ATTR_REQUIRED) !== true)
    .filter((f) => f.subType !== FIELD_SUBTYPE_OBJECT && !f.resolvedIsArray())
    .filter((f) => {
      const kind = viewKindFor(f, f.views()[0]); // resolving accessor (ADR-0039)
      return kind !== VIEW_SUBTYPE_CHECKBOX && kind !== VIEW_SUBTYPE_IMAGE;
    })
    .map((f) => f.name);
}

/** Names of the two symbols the blank-normalizer emits, kept out of the template string. */
const BLANK_FIELDS_CONST = "BLANK_OPTIONAL_FIELDS";
const BLANK_NORMALIZER = "normalizeBlankOptionals";

export function renderFormFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );
  // FR-017 Tier 3: a TPH subtype's form omits the discriminator field (it's
  // implicit — the form is subtype-specific — and injected server-side). The
  // create schema correspondingly drops the pinned literal so RHF validation
  // doesn't require a field the user never fills.
  const tphPin = tphDiscriminatorPin(entity);
  const fields = visibleFields(entity, tphPin?.fieldName);
  // #227: the resolver must match the MODE. `defaultValues` is what distinguishes
  // edit from create everywhere else in this template, so it selects the schema too.
  // InsertSchema's optionals are `.optional()` (absent ok, null REJECTED); an edit is
  // seeded from a real row where every unset optional column is `null`, so validating
  // an edit against InsertSchema fails on untouched fields and handleSubmit never
  // fires — the save silently does nothing. UpdateSchema is `.optional().nullable()`,
  // and is the semantically right pairing anyway: an edit submits a PATCH, so it
  // validates against the PATCH schema (still enforcing min/max/enum on present keys,
  // just not demanding required keys the PATCH isn't sending — FR-035 present-key).
  const omitTph = (schema: string) => tphPin !== undefined
    ? `${schema}.omit({ ${tphPin.fieldName}: true })`
    : schema;
  const insertSchema = omitTph(`${entityName}InsertSchema`);
  const updateSchema = omitTph(`${entityName}UpdateSchema`);
  const formSchema = `props.defaultValues !== undefined ? ${updateSchema} : ${insertSchema}`;

  const ReactElementSym = imp("t:ReactElement@react");
  const SubmitHandlerSym = imp("t:SubmitHandler@react-hook-form");
  const useEntityFormSym = imp("useEntityForm@@metaobjectsdev/react");

  // #223 — a blank optional control submits `""`, which is not what the user meant and,
  // on a nullable date/timestamp column, is not even a legal value. The correct handling
  // is a TRISTATE and it needs create-vs-edit awareness, which is why it cannot be the
  // blanket "strip empty strings" a downstream project reached for: under FR-035's
  // present-key PATCH semantics an ABSENT key means "leave untouched", so stripping a
  // cleared field on the edit path silently fails to clear it.
  //
  //   CREATE (no defaultValues) — omit the key, so the column's DEFAULT/NULL applies.
  //   EDIT   (defaultValues)    — send explicit null, which is what CLEARS the column.
  //
  // Emitted only when the entity actually has a blankable optional field, so an
  // all-required form's output is byte-identical to before.
  const blankFields = blankableOptionalFields(fields);
  const blankHelper = blankFields.length === 0 ? "" : `
const ${BLANK_FIELDS_CONST} = ${JSON.stringify(blankFields)} as const;

/**
 * Normalize blank optional inputs on the way out of the form (#223).
 * On create a blank field is OMITTED (the column defaults); on edit it is sent as
 * explicit \`null\` (present-null clears, per the FR-035 PATCH tristate).
 */
function ${BLANK_NORMALIZER}(values: Record<string, unknown>, isEdit: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const key of ${BLANK_FIELDS_CONST}) {
    if (out[key] !== '') continue;
    if (isEdit) out[key] = null;
    else delete out[key];
  }
  return out;
}
`;
  // The cast chain is unchanged in spirit from the previous `props.onSubmit as never`:
  // RHF's SubmitHandler is generic over the form's own inferred shape, which is not the
  // Row type this component's prop is declared against.
  const submitHandlerExpr = blankFields.length === 0
    ? "props.onSubmit as never"
    : `((values: Record<string, unknown>, event?: unknown) =>\n        props.onSubmit(` +
      `${BLANK_NORMALIZER}(values, props.defaultValues !== undefined) as never, event as never)) as never`;

  // The flat scalar block: a label + pre-bound input + error span, driven
  // entirely by the entity constants via `form.input.<field>`. Unchanged.
  const scalarBlock = (f: string) => `        <div className="metaobjects-field" key=${JSON.stringify(f)}>
          <label className="metaobjects-field-label" htmlFor={${entityName}.${f}.name}>
            {${entityName}.${f}.label}
          </label>
          <input className="metaobjects-field-input" {...form.input.${f}} />
          {form.formState.errors.${f} !== undefined && (
            <span className="metaobjects-field-error" role="alert">
              {String(form.formState.errors.${f}?.message ?? '')}
            </span>
          )}
        </div>`;

  // Shared label + control + error wrapper used by the view-kind dispatch
  // branches below (select / textarea / checkbox / radio). `scalarBlock`
  // stays untouched as the plain-<input> fallback (bound via `form.input.*`).
  const labelAndError = (f: string, control: string) =>
    `        <div className="metaobjects-field" key=${JSON.stringify(f)}>
          <label className="metaobjects-field-label" htmlFor={${entityName}.${f}.name}>
            {${entityName}.${f}.label}
          </label>
${control}
          {form.formState.errors.${f} !== undefined && (
            <span className="metaobjects-field-error" role="alert">
              {String(form.formState.errors.${f}?.message ?? '')}
            </span>
          )}
        </div>`;

  // Dispatch a visible scalar field to its control by declared view kind: an
  // explicit view.textarea/checkbox/radio child, or an enum defaulting to a
  // dropdown when it carries no explicit view. Everything else falls back to
  // scalarBlock's typed <input> bound via `form.input.<field>`.
  const fieldControlFor = (field: MetaField): string => {
    const name = field.name;
    const view = field.views()[0]; // resolving accessor (ADR-0039)
    const kind = viewKindFor(field, view);
    // Enum member symbols are validated to /^[A-Za-z_][A-Za-z0-9_]*$/, so raw
    // interpolation into JSX attribute/text positions is safe (no escaping).
    if (kind === VIEW_SUBTYPE_DROPDOWN) {
      const values = enumValues(field);
      const required = field.attr(FIELD_ATTR_REQUIRED) === true;
      const empty = required ? "" : `            <option value="">Select…</option>\n`;
      const options = values.map((v) => `            <option value="${v}">${v}</option>`).join("\n");
      return labelAndError(
        name,
        `          <select aria-label={${entityName}.${name}.label} className="metaobjects-field-input" {...form.register("${name}")}>\n${empty}${options}\n          </select>`,
      );
    }
    if (kind === VIEW_SUBTYPE_TEXTAREA) {
      const rows = (view?.attr(VIEW_TEXTAREA_ATTR_ROWS) as number | undefined) ?? 4;
      return labelAndError(
        name,
        `          <textarea aria-label={${entityName}.${name}.label} className="metaobjects-field-input" rows={${rows}} {...form.register("${name}")} />`,
      );
    }
    if (kind === VIEW_SUBTYPE_CHECKBOX) {
      return labelAndError(
        name,
        `          <input aria-label={${entityName}.${name}.label} type="checkbox" className="metaobjects-field-checkbox" {...form.register("${name}")} />`,
      );
    }
    if (kind === VIEW_SUBTYPE_RADIO) {
      const values = enumValues(field);
      const radios = values
        .map(
          (v) =>
            `            <label className="metaobjects-field-radio"><input type="radio" value="${v}" {...form.register("${name}")} /> ${v}</label>`,
        )
        .join("\n");
      return labelAndError(
        name,
        `          <fieldset aria-label={${entityName}.${name}.label} className="metaobjects-field-radios">\n${radios}\n          </fieldset>`,
      );
    }
    if (kind === VIEW_SUBTYPE_IMAGE) {
      // ImageMeta declares every field optional (not `| undefined`), so under
      // exactOptionalPropertyTypes an explicit `key: undefined` literal is a
      // TS2375 error for a consumer's tsconfig. Emit a fragment ONLY for an
      // attr that is actually present; an absent attr contributes nothing.
      const numFragment = (attrName: string, key: string): string | undefined => {
        const v = view?.attr(attrName);
        return typeof v === "number" ? `${key}: ${v}` : undefined;
      };
      const store = view?.attr(VIEW_IMAGE_ATTR_STORE);
      const storeFragment = typeof store === "string" ? `store: ${JSON.stringify(store)}` : undefined;
      const accept = view?.attr(VIEW_IMAGE_ATTR_ACCEPT);
      const acceptFragment = Array.isArray(accept) ? `accept: ${JSON.stringify(accept)}` : undefined;
      const fragments = [
        numFragment(VIEW_IMAGE_ATTR_ASPECT_RATIO, "aspectRatio"),
        numFragment(VIEW_IMAGE_ATTR_MAX_EDGE, "maxEdge"),
        storeFragment,
        acceptFragment,
        numFragment(VIEW_IMAGE_ATTR_MAX_BYTES, "maxBytes"),
      ].filter((f): f is string => f !== undefined);
      const meta = fragments.length > 0 ? `{ ${fragments.join(", ")} }` : "{}";
      const control = `          <Controller name=${JSON.stringify(name)} control={form.control} render={({ field: f }) => (
            <ImageUpload value={f.value as string | null} onChange={f.onChange} meta={${meta}} />
          )} />`;
      return labelAndError(name, control);
    }
    return scalarBlock(name);
  };

  // For each visible field: scalars keep the flat `form.input.<field>` block; a
  // `field.object` with a resolvable `@objectRef` recurses into the referenced
  // value object as a nested <fieldset> sub-form (issue #95). useFieldArray
  // declarations for array-of-value-object fields hoist to the component top.
  const blocks: string[] = [];
  const fieldArrayHooks: string[] = [];
  for (const f of fields) {
    if (resolveValueObject(f, ctx) === undefined) {
      blocks.push(fieldControlFor(f));
      continue;
    }
    const r = renderNestedField(f, f.name, false, ctx, new Set<string>(), 0);
    blocks.push(r.jsx);
    fieldArrayHooks.push(...r.hooks);
  }
  const fieldBlocks = blocks.join("\n");
  const hookSection =
    fieldArrayHooks.length > 0 ? `\n  ${fieldArrayHooks.join("\n  ")}` : "";

  // Only pull in useFieldArray when an array-of-value-object field needs it.
  const useFieldArrayImport =
    fieldArrayHooks.length > 0 ? `import { useFieldArray } from "react-hook-form";\n` : "";

  // Only pull in Controller + ImageUpload when a view.image field needs them —
  // a native <input> can't drive a file-upload control's value/onChange
  // contract, so image fields are wrapped in react-hook-form's <Controller>.
  const hasImage = fields.some((f) => f.views()[0]?.subType === VIEW_SUBTYPE_IMAGE);
  const imageImports = hasImage
    ? `import { Controller } from "react-hook-form";\nimport { ImageUpload } from "@metaobjectsdev/react";\n`
    : "";

  const literalImports = code`
import {
  ${entityName},
  ${entityName}InsertSchema,
  ${entityName}UpdateSchema,
} from ${JSON.stringify(entityFileSpec)};
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityFileSpec)};
${useFieldArrayImport}${imageImports}`;

  const body = code`${blankHelper}
export interface ${entityName}FormProps {
  onSubmit: ${SubmitHandlerSym}<Partial<${entityName}Row>>;
  defaultValues?: Partial<${entityName}Row>;
  submitLabel?: string;
  className?: string;
}

/**
 * Generated React form for ${entityName}. All field metadata (name, label,
 * placeholder, html input type, RHF validation rules) comes from the
 * ${entityName} constants emitted alongside this file. Validation uses the
 * generated Zod schema, shared with the server-side Fastify route.
 *
 * Customize: this file is regenerated on every \`forge gen\`. If you need a
 * custom layout, write your own component using useEntityForm + the
 * ${entityName} constants directly.
 */
export function ${entityName}Form(props: ${entityName}FormProps): ${ReactElementSym} {
  const form = ${useEntityFormSym}(
    ${entityName},
    ${formSchema},
    props.defaultValues !== undefined ? { defaultValues: props.defaultValues } : {},
  );${hookSection}
  return (
    <form
      className={props.className ?? 'metaobjects-form'}
      data-entity={${entityName}.$entity}
      onSubmit={form.handleSubmit(${submitHandlerExpr})}
    >
${fieldBlocks}
      <div className="metaobjects-form-actions">
        <button className="metaobjects-form-submit" type="submit" disabled={form.formState.isSubmitting}>
          {props.submitLabel ?? 'Submit'}
        </button>
      </div>
    </form>
  );
}
`;

  const header =
    `// ${GENERATED_HEADER} — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n` +
    `// Customize via ${entityName}.extra.tsx (custom layouts, per-field components, etc.).\n`;

  return header + literalImports.toString() + body.toString();
}
