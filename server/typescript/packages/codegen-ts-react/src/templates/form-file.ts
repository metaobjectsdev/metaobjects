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
import { MetaField, MetaObject, stripPackage } from "@metaobjectsdev/metadata";
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
  VIEW_TEXTAREA_ATTR_ROWS,
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
 *  an enum with no view defaults to a dropdown; otherwise null (typed <input>). */
function viewKindFor(field: MetaField): string | null {
  const view = field.views()[0]; // resolving accessor (ADR-0039)
  if (view !== undefined) return view.subType;
  if (field.subType === FIELD_SUBTYPE_ENUM) return VIEW_SUBTYPE_DROPDOWN;
  return null;
}

/** The field's declared @values (enum member symbols), or [] when absent. */
function enumValues(field: MetaField): string[] {
  return (field.attr(FIELD_ATTR_VALUES) as string[] | undefined) ?? [];
}

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
  const formSchema = tphPin !== undefined
    ? `${entityName}InsertSchema.omit({ ${tphPin.fieldName}: true })`
    : `${entityName}InsertSchema`;

  const ReactElementSym = imp("t:ReactElement@react");
  const SubmitHandlerSym = imp("t:SubmitHandler@react-hook-form");
  const useEntityFormSym = imp("useEntityForm@@metaobjectsdev/react");

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
    const kind = viewKindFor(field);
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
      const rows = (field.views()[0]?.attr(VIEW_TEXTAREA_ATTR_ROWS) as number | undefined) ?? 4;
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

  const literalImports = code`
import {
  ${entityName},
  ${entityName}InsertSchema,
} from ${JSON.stringify(entityFileSpec)};
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityFileSpec)};
${useFieldArrayImport}`;

  const body = code`
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
      onSubmit={form.handleSubmit(props.onSubmit as never)}
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
