// React form template — emits a per-entity Form component that delegates
// to useEntityForm from @metaobjects/runtime-ts-client/react. The generated file
// is ~25 lines: wire up the form, render each field's pre-bound input,
// let the helper carry all metadata-derived attrs.
//
// What gets emitted:
//   - A `<EntityName>Form` component that calls useEntityForm and spreads
//     form.input.<field> onto <input> elements.
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
import { MetaField, MetaObject } from "@metaobjects/metadata";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DEFAULT,
} from "@metaobjects/metadata";
import { type RenderContext, withExt } from "../render-context.js";
import { GENERATED_HEADER } from "../constants.js";

function primaryFieldNames(entity: MetaObject): Set<string> {
  const set = new Set<string>();
  // identities() returns effective identities, so inherited identities (from extends:/super:) are included.
  for (const child of entity.identities()) {
    if (child.subType !== IDENTITY_SUBTYPE_PRIMARY) continue;
    const fields = child.ownAttr(IDENTITY_ATTR_FIELDS);
    const fieldsList = Array.isArray(fields) ? fields : (typeof fields === "string" ? [fields] : []);
    for (const f of fieldsList) if (typeof f === "string") set.add(f);
  }
  return set;
}

function isAutoManaged(field: MetaField): boolean {
  const def = field.ownAttr(FIELD_ATTR_DEFAULT);
  if (typeof def === "string") {
    const upper = def.toUpperCase();
    if (upper === "CURRENT_TIMESTAMP" || upper === "NOW" || upper === "NOW()") return true;
  }
  return false;
}

/** Visible form fields = all fields minus PK and DB-auto-defaulted. */
function visibleFields(entity: MetaObject): string[] {
  const pkNames = primaryFieldNames(entity);
  const names: string[] = [];
  // fields() returns effective fields, so inherited fields (from extends:/super:) are included in forms.
  for (const child of entity.fields()) {
    if (child.ownAttr("formExclude") === true) continue;
    if (pkNames.has(child.name)) continue;
    if (isAutoManaged(child)) continue;
    names.push(child.name);
  }
  return names;
}

export function renderFormFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const entityFileSpec = withExt(`./${entityName}`, ctx.extStyle);
  const fields = visibleFields(entity);

  const ReactElementSym = imp("t:ReactElement@react");
  const SubmitHandlerSym = imp("t:SubmitHandler@react-hook-form");
  const useEntityFormSym = imp("useEntityForm@@metaobjects/runtime-ts-client/react");

  // For each visible field, emit a label + input + error block.
  // The input gets every metadata-derived attr via {...form.input.<field>}.
  const fieldBlocks = fields
    .map(
      (f) => `        <div className="metaobjects-field" key=${JSON.stringify(f)}>
          <label className="metaobjects-field-label" htmlFor={${entityName}.${f}.name}>
            {${entityName}.${f}.label}
          </label>
          <input className="metaobjects-field-input" {...form.input.${f}} />
          {form.formState.errors.${f} !== undefined && (
            <span className="metaobjects-field-error" role="alert">
              {String(form.formState.errors.${f}?.message ?? '')}
            </span>
          )}
        </div>`,
    )
    .join("\n");

  const literalImports = code`
import {
  ${entityName},
  ${entityName}InsertSchema,
} from ${JSON.stringify(entityFileSpec)};
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityFileSpec)};
`;

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
    ${entityName}InsertSchema,
    props.defaultValues !== undefined ? { defaultValues: props.defaultValues } : {},
  );
  return (
    <form
      className={props.className ?? 'metaobjects-form'}
      data-entity={${entityName}.$entity}
      onSubmit={form.handleSubmit(props.onSubmit as never)}
    >
${fieldBlocks}
      <button type="submit" disabled={form.formState.isSubmitting}>
        {props.submitLabel ?? 'Submit'}
      </button>
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
