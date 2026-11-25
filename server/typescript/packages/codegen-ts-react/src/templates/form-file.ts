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
// Form generation is OPT-IN at PROJECT level: add `formFile()` to `generators`
// in metaobjects.config.ts. Most projects don't need stock forms. Narrow it to
// a subset with `formFile({ filter })`. There is no `@emitForm` metadata
// attribute — it was never registered vocabulary, so `meta verify` rejects it
// (ERR_UNKNOWN_ATTR); the doc line here used to claim it turned generation ON,
// while the filter beside it read it as an opt-OUT. Neither is true now.

import { arr, call, props, str, TsWriter, type Props } from "@metaobjectsdev/codegen-ts/engine";
import { MetaField, MetaObject, MetaView } from "@metaobjectsdev/metadata";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DEFAULT,
  FIELD_SUBTYPE_OBJECT,
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
import {
  type RenderContext,
  entityModuleSpecifier,
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  sidecarComment,
  viewForContext,
  VIEW_CONTEXT_FORM,
  effectivePackage,
  isCredentialField,
  flatSurfaceFields,
} from "@metaobjectsdev/codegen-ts/engine";
import { humanize, valueObjectFor, numericInputControl } from "@metaobjectsdev/codegen-ts/templates/field-meta";
import { tphDiscriminatorPin } from "@metaobjectsdev/codegen-ts/engine";
import { hasInsertRefinements } from "@metaobjectsdev/codegen-ts/templates/zod-validators";

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
  for (const child of flatSurfaceFields(entity)) {
    // ADR-0039: resolving — a field may inherit @formExclude via extends.
    if (child.attr(FIELD_ATTR_FORM_EXCLUDE) === true) continue;
    // A credential is never edited through a generated form: the generated write route
    // strips it, and a form has no way to set one correctly (no hashing seam).
    if (isCredentialField(child)) continue;
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

/** Resolve a `field.object`'s `@objectRef` to the referenced value object from the loaded
 *  root — `valueObjectFor`, in `@metaobjectsdev/codegen-ts`, because `agent/ui.md` has to
 *  ask the SAME question to document what this generator renders. When the two answered
 *  separately the page printed the field's view kind (`text`) as the control for a field
 *  this generator emits as a nested sub-form and no input at all. */
function resolveValueObject(field: MetaField, ctx: RenderContext): MetaObject | undefined {
  return valueObjectFor(field, ctx.loadedRoot);
}

/** A real HTML <input type=...> for a scalar field subtype, or undefined (text). */
function htmlTypeForSubType(subType: string): string | undefined {
  switch (subType) {
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
  return dynamic ? `\`${path}\`` : str(path);
}

/** A stable, identifier-safe useFieldArray hook variable for a static path. */
function arrayHookVar(path: string): string {
  return `${path.replace(/[^A-Za-z0-9]+/g, "_")}Array`;
}

/** One field's markup, written later, and the useFieldArray hooks it needs at the component top. */
interface FieldRender {
  write: (w: TsWriter) => void;
  hooks: FieldArrayHook[];
}

/** A useFieldArray declaration hoisted to the top of the component. */
interface FieldArrayHook {
  hookVar: string;
  path: string;
}

/** `<fieldset>` with a legend: the shell every nested value object renders in. */
function writeFieldset(w: TsWriter, path: string, legend: string, body: () => void): void {
  w.block(`<fieldset className="metaobjects-fieldset" key=${str(path)}>`, () => {
    w.line(`<legend className="metaobjects-fieldset-legend">${legend}</legend>`);
    body();
  }, "</fieldset>");
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
  const label = humanize(field.name);
  if (vo === undefined) {
    // Scalar / enum / unresolved object → a single bound input.
    const numeric = numericInputControl(field.subType);
    const htmlType = numeric?.htmlType ?? htmlTypeForSubType(field.subType);
    const typeAttr =
      (htmlType !== undefined ? ` type=${str(htmlType)}` : "") +
      (numeric?.step !== undefined ? ` step=${str(numeric.step)}` : "") +
      (numeric?.inputMode !== undefined ? ` inputMode=${str(numeric.inputMode)}` : "");
    return {
      write: (w) =>
        w.block(`<div className="metaobjects-field" key=${str(path)}>`, () => {
          w.line(`<label className="metaobjects-field-label">${label}</label>`);
          w.line(`<input className="metaobjects-field-input"${typeAttr} {...form.register(${registerArg(path, dynamic)})} />`);
        }, "</div>"),
      hooks: [],
    };
  }

  const voKey = vo.fqn();
  if (visited.has(voKey) || depth >= MAX_VO_DEPTH) {
    // Cycle or too deep — emit a labeled shell + TODO instead of a flat input.
    return {
      write: (w) =>
        writeFieldset(w, path, label, () =>
          w.line(`{/* TODO(#95): nested value object ${vo.name} not expanded (recursion guard). Author this sub-form by hand. */}`),
        ),
      hooks: [],
    };
  }
  const nextVisited = new Set(visited);
  nextVisited.add(voKey);

  if (!field.resolvedIsArray()) {
    // Single nested value object → a fieldset recursing into its fields.
    const inner = vo.fields().map((sub) => renderNestedField(sub, `${path}.${sub.name}`, dynamic, ctx, nextVisited, depth + 1));
    return {
      write: (w) => writeFieldset(w, path, label, () => {
        for (const r of inner) r.write(w);
      }),
      hooks: inner.flatMap((r) => r.hooks),
    };
  }

  // Array of value objects.
  if (dynamic) {
    // Already inside an array element — a static useFieldArray name is impossible.
    // Degrade to the element shape + a single clear TODO (never a flat input).
    return {
      write: (w) =>
        writeFieldset(w, path, label, () => {
          w.line("{/* TODO(#95): arrays of value objects nested inside another array are not auto-wired");
          w.line("(the react-hook-form path is dynamic). Render this repeatable group by hand. */}");
        }),
      hooks: [],
    };
  }

  // Static path → a useFieldArray-based repeatable group.
  const hookVar = arrayHookVar(path);
  const elementPath = `${path}.\${index}`;
  const inner = vo.fields().map((sub) => renderNestedField(sub, `${elementPath}.${sub.name}`, true, ctx, nextVisited, depth + 1));
  const itemLabel = humanize(vo.name);
  return {
    write: (w) =>
      w.block(`<div className="metaobjects-field-array" key=${str(path)}>`, () => {
        w.line(`<span className="metaobjects-field-array-label">${label}</span>`);
        w.block(`{${hookVar}.fields.map((item, index) => (`, () => {
          w.block(`<fieldset className="metaobjects-fieldset" key={item.id}>`, () => {
            w.line(`<legend className="metaobjects-fieldset-legend">${itemLabel} {index + 1}</legend>`);
            for (const r of inner) r.write(w);
            w.block(
              `<button type="button" className="metaobjects-field-array-remove" onClick={() => ${hookVar}.remove(index)}>`,
              () => w.line("Remove"),
              "</button>",
            );
          }, "</fieldset>");
        }, "))}");
        w.block(
          `<button type="button" className="metaobjects-field-array-add" onClick={() => ${hookVar}.append({} as never)}>`,
          () => w.line(`Add ${itemLabel}`),
          "</button>",
        );
      }, "</div>"),
    hooks: [{ hookVar, path }, ...inner.flatMap((r) => r.hooks)],
  };
}

/** The view kind that drives control selection: an explicit view child wins;
 *  an enum with no view defaults to a dropdown; otherwise null (typed <input>).
 *  Takes the already-resolved view (callers that also need view attrs, like
 *  the textarea `@rows` lookup, fetch it once via `viewForContext(field,
 *  VIEW_CONTEXT_FORM)` and pass it through rather than re-deriving it here). */
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
      // #356 + ADR-0039: the view declared for the FORM, resolving through extends.
      const kind = viewKindFor(f, viewForContext(f, VIEW_CONTEXT_FORM));
      return kind !== VIEW_SUBTYPE_CHECKBOX && kind !== VIEW_SUBTYPE_IMAGE;
    })
    .map((f) => f.name);
}

/** Names of the two symbols the blank-normalizer emits, kept out of the template string. */
const BLANK_FIELDS_CONST = "BLANK_OPTIONAL_FIELDS";
const BLANK_NORMALIZER = "normalizeBlankOptionals";

/** The React form for `entity`, as a file. */
export function renderFormFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeFormFile(w, entity, ctx);
  return w.toString();
}

/** Write the React form for `entity` (header, imports and the component) into `w`. */
export function writeFormFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
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
  // A refined (cross-field) schema cannot be `.omit()`ed; codegen exports the refined,
  // discriminator-less `<Name>InsertBodySchema` for exactly this TPH case.
  const refinedTph = tphPin !== undefined && hasInsertRefinements(entity);
  const entityRef = w.use(entityName, entityFileSpec);
  const insertSchemaName = w.use(refinedTph ? `${entityName}InsertBodySchema` : `${entityName}InsertSchema`, entityFileSpec);
  const updateSchemaName = w.use(`${entityName}UpdateSchema`, entityFileSpec);
  const rowType = w.useType(entityName, entityFileSpec, `${entityName}Row`);
  const insertSchema = refinedTph ? insertSchemaName : omitTph(insertSchemaName);
  const updateSchema = omitTph(updateSchemaName);
  const formSchema = `props.defaultValues !== undefined ? ${updateSchema} : ${insertSchema}`;

  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
    sidecarComment(`${entityName}.extra.tsx`),
  );

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
  // all-required form is unchanged.
  const blankFields = blankableOptionalFields(fields);
  if (blankFields.length > 0) writeBlankNormalizer(w, blankFields);

  const isEdit = "props.defaultValues !== undefined";
  // Blanks are normalized BEFORE validation too. react-hook-form runs the resolver on the
  // raw values ahead of the submit callback, and since 1.0.9 a date/timestamp schema
  // rejects `""` — so normalizing only in the callback left a blank optional date failing
  // validation and the submit never firing. The resolver's schema is preprocessed by the
  // same tristate rule; the callback's pass below is then a no-op kept for safety.
  const resolverSchema = blankFields.length === 0
    ? formSchema
    : call(`${w.use("z", "zod")}.preprocess`, [
        `(v) => ${BLANK_NORMALIZER}(v as Record<string, unknown>, ${isEdit})`,
        formSchema,
      ]);
  // The cast chain is unchanged in spirit from the previous `props.onSubmit as never`:
  // RHF's SubmitHandler is generic over the form's own inferred shape, which is not the
  // Row type this component's prop is declared against.
  const submitHandler = blankFields.length === 0
    ? "props.onSubmit as never"
    : [
        "((values: Record<string, unknown>, event?: unknown) => ",
        call("props.onSubmit", [`${BLANK_NORMALIZER}(values, ${isEdit}) as never`, "event as never"]),
        ") as never",
      ];

  // For each visible field: scalars keep the flat `form.input.<field>` block; a
  // `field.object` with a resolvable `@objectRef` recurses into the referenced
  // value object as a nested <fieldset> sub-form (issue #95). useFieldArray
  // declarations for array-of-value-object fields hoist to the component top.
  const renders: FieldRender[] = fields.map((f) =>
    resolveValueObject(f, ctx) === undefined
      ? { write: (fw: TsWriter) => writeFieldControl(fw, f, entityRef), hooks: [] }
      : renderNestedField(f, f.name, false, ctx, new Set<string>(), 0),
  );
  const hooks = renders.flatMap((r) => r.hooks);

  w.blank();
  w.block(`export interface ${entityName}FormProps {`, () => {
    w.line(`onSubmit: ${w.useType("SubmitHandler", "react-hook-form")}<Partial<${rowType}>>;`);
    w.line(`defaultValues?: Partial<${rowType}>;`);
    w.line("submitLabel?: string;");
    w.line("className?: string;");
  });
  w.blank();
  w.doc(
    `Generated React form for ${entityName}. All field metadata (name, label,`,
    "placeholder, html input type, RHF validation rules) comes from the",
    `${entityName} constants emitted alongside this file. Validation uses the`,
    "generated Zod schema, shared with the server-side Fastify route.",
    "",
    "Customize: this file is regenerated on every `forge gen`. If you need a",
    "custom layout, write your own component using useEntityForm + the",
    `${entityName} constants directly.`,
  );
  const reactElement = w.useType("ReactElement", "react");
  w.block(`export function ${entityName}Form(props: ${entityName}FormProps): ${reactElement} {`, () => {
    w.line("const form = ", call(w.use("useEntityForm", "@metaobjectsdev/react"), [
      entityRef,
      resolverSchema,
      `${isEdit} ? { defaultValues: props.defaultValues } : {}`,
    ]), ";");
    for (const h of hooks) {
      w.line(`const ${h.hookVar} = ${w.use("useFieldArray", "react-hook-form")}({ control: form.control, name: ${str(h.path)} as never });`);
    }
    w.block("return (", () => {
      w.open("<form");
      w.line(`className={props.className ?? "metaobjects-form"}`);
      w.line(`data-entity={${entityRef}.$entity}`);
      w.line("onSubmit={", call("form.handleSubmit", [submitHandler]), "}");
      w.reopen(">");
      for (const r of renders) r.write(w);
      w.block(`<div className="metaobjects-form-actions">`, () => {
        w.block(`<button className="metaobjects-form-submit" type="submit" disabled={form.formState.isSubmitting}>`, () => {
          w.line(`{props.submitLabel ?? "Submit"}`);
        }, "</button>");
      }, "</div>");
      w.close("</form>");
    }, ");");
  });
}

/** The module-level constant and function that normalize blank optional inputs (#223). */
function writeBlankNormalizer(w: TsWriter, blankFields: readonly string[]): void {
  w.blank();
  w.line(`const ${BLANK_FIELDS_CONST} = `, arr(blankFields.map(str)), " as const;");
  w.blank();
  w.doc(
    "Normalize blank optional inputs on the way out of the form (#223).",
    "On create a blank field is OMITTED (the column defaults); on edit it is sent as",
    "explicit `null` (present-null clears, per the FR-035 PATCH tristate).",
  );
  w.block(`function ${BLANK_NORMALIZER}(values: Record<string, unknown>, isEdit: boolean): Record<string, unknown> {`, () => {
    w.line("const out: Record<string, unknown> = { ...values };");
    w.block(`for (const key of ${BLANK_FIELDS_CONST}) {`, () => {
      w.block(`if (out[key] !== "") {`, () => w.line("continue;"));
      w.open("if (isEdit) {");
      w.line("out[key] = null;");
      w.reopen("} else {");
      w.line("delete out[key];");
      w.close("}");
    });
    w.line("return out;");
  });
}

/**
 * The label + control + error wrapper every top-level field renders in. `control` writes the
 * control itself (an <input>, <select>, <textarea>, radio <fieldset> or image <Controller>).
 */
function writeLabelAndError(w: TsWriter, entityRef: string, name: string, control: () => void): void {
  w.block(`<div className="metaobjects-field" key=${str(name)}>`, () => {
    w.line(`<label className="metaobjects-field-label" htmlFor={${entityRef}.${name}.name}>{${entityRef}.${name}.label}</label>`);
    control();
    w.block(`{form.formState.errors.${name} !== undefined && (`, () => {
      w.block(`<span className="metaobjects-field-error" role="alert">`, () => {
        w.line(`{String(form.formState.errors.${name}?.message ?? "")}`);
      }, "</span>");
    }, ")}");
  }, "</div>");
}

/**
 * Dispatch a visible scalar field to its control by declared view kind: an
 * explicit view.textarea/checkbox/radio/image child, or an enum defaulting to a
 * dropdown when it carries no explicit view. Everything else is a typed <input>
 * bound via `form.input.<field>`, which carries the field's aria-label.
 */
function writeFieldControl(w: TsWriter, field: MetaField, entityRef: string): void {
  const name = field.name;
  const register = `{...form.register(${str(name)})}`;
  const ariaLabel = `aria-label={${entityRef}.${name}.label}`;
  // #356 + ADR-0039: the view declared for the FORM, resolving through extends.
  const view = viewForContext(field, VIEW_CONTEXT_FORM);
  const kind = viewKindFor(field, view);
  // Enum member symbols are validated to /^[A-Za-z_][A-Za-z0-9_]*$/, so raw
  // interpolation into JSX attribute/text positions is safe (no escaping).
  writeLabelAndError(w, entityRef, name, () => {
    if (kind === VIEW_SUBTYPE_DROPDOWN) {
      w.block(`<select ${ariaLabel} className="metaobjects-field-input" ${register}>`, () => {
        if (field.attr(FIELD_ATTR_REQUIRED) !== true) w.line(`<option value="">Select…</option>`);
        for (const v of enumValues(field)) w.line(`<option value=${str(v)}>${v}</option>`);
      }, "</select>");
      return;
    }
    if (kind === VIEW_SUBTYPE_TEXTAREA) {
      const rows = (view?.attr(VIEW_TEXTAREA_ATTR_ROWS) as number | undefined) ?? 4;
      w.line(`<textarea ${ariaLabel} className="metaobjects-field-input" rows={${rows}} ${register} />`);
      return;
    }
    if (kind === VIEW_SUBTYPE_CHECKBOX) {
      w.line(`<input ${ariaLabel} type="checkbox" className="metaobjects-field-checkbox" ${register} />`);
      return;
    }
    if (kind === VIEW_SUBTYPE_RADIO) {
      w.block(`<fieldset ${ariaLabel} className="metaobjects-field-radios">`, () => {
        for (const v of enumValues(field)) {
          w.line(`<label className="metaobjects-field-radio"><input type="radio" value=${str(v)} ${register} /> ${v}</label>`);
        }
      }, "</fieldset>");
      return;
    }
    if (kind === VIEW_SUBTYPE_IMAGE) {
      // A native <input> can't drive a file-upload control's value/onChange contract, so an
      // image field is wrapped in react-hook-form's <Controller>.
      const controller = w.use("Controller", "react-hook-form");
      const imageUpload = w.use("ImageUpload", "@metaobjectsdev/react/image-upload");
      w.block(`<${controller} name=${str(name)} control={form.control} render={({ field: f }) => (`, () => {
        w.line(`<${imageUpload} value={f.value as string | null} onChange={f.onChange} meta={`, imageMeta(view), "} />");
      }, ")} />");
      return;
    }
    w.line(`<input className="metaobjects-field-input" {...form.input.${name}} />`);
  });
}

/**
 * The `meta` object an image field's <ImageUpload> receives. ImageMeta declares every field
 * optional (not `| undefined`), so under exactOptionalPropertyTypes an explicit
 * `key: undefined` is a TS2375 error in a consumer's tsconfig: a member is written ONLY for an
 * attr that is actually present.
 */
function imageMeta(view: MetaView | undefined): Props {
  const meta = props();
  const num = (attrName: string, key: string): void => {
    const v = view?.attr(attrName);
    if (typeof v === "number") meta.set(key, String(v));
  };
  num(VIEW_IMAGE_ATTR_ASPECT_RATIO, "aspectRatio");
  num(VIEW_IMAGE_ATTR_MAX_EDGE, "maxEdge");
  const store = view?.attr(VIEW_IMAGE_ATTR_STORE);
  if (typeof store === "string") meta.set("store", str(store));
  const accept = view?.attr(VIEW_IMAGE_ATTR_ACCEPT);
  if (Array.isArray(accept)) meta.set("accept", arr(accept.map((a) => str(String(a)))));
  num(VIEW_IMAGE_ATTR_MAX_BYTES, "maxBytes");
  return meta;
}
