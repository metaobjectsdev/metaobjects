// Angular 18 form template — emits a per-entity standalone Component using
// Angular reactive forms (FormBuilder + Validators) and signal-based input
// for the entity-under-edit. Mirrors React's <Entity>Form.tsx.
//
// Visible-fields rules match the React generator:
//   - Primary-identity fields excluded (DB-generated)
//   - Fields with @formExclude: true excluded
//   - Timestamp fields with default CURRENT_TIMESTAMP excluded (auto-managed)
//
// Form-generation is OPT-IN per entity via `@emitAngular: true` on the
// object metadata. (The factory layer applies that filter.)

import { code, imp } from "ts-poet";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
} from "@metaobjectsdev/metadata";
import { type RenderContext, GENERATED_HEADER, entityModuleSpecifier } from "@metaobjectsdev/codegen-ts";

function primaryFieldNames(entity: MetaObject): Set<string> {
  const set = new Set<string>();
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

function visibleFields(entity: MetaObject): MetaField[] {
  const pkNames = primaryFieldNames(entity);
  const out: MetaField[] = [];
  for (const child of entity.fields()) {
    if (child.ownAttr("formExclude") === true) continue;
    if (pkNames.has(child.name)) continue;
    if (isAutoManaged(child)) continue;
    out.push(child);
  }
  return out;
}

function controlDefaultFor(field: MetaField): string {
  switch (field.subType) {
    case FIELD_SUBTYPE_BOOLEAN: return "false";
    case FIELD_SUBTYPE_CURRENCY: return "0";
    default: return "''";
  }
}

function controlValidatorsFor(field: MetaField): string[] {
  const out: string[] = [];
  if (field.isRequired) out.push("Validators.required");
  const max = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  if (typeof max === "number") out.push(`Validators.maxLength(${max})`);
  return out;
}

function controlTypeFor(field: MetaField): string {
  if (field.subType === FIELD_SUBTYPE_BOOLEAN) return "checkbox";
  if (field.subType === FIELD_SUBTYPE_CURRENCY) return "currency";
  return "text";
}

export function renderFormFile(entity: MetaObject, ctx: RenderContext): string {
  const entityName = entity.name;
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    entity.package,
    entityName,
    ctx.extStyle,
  );
  const fields = visibleFields(entity);

  const ComponentSym = imp("Component@@angular/core");
  const inputSym = imp("input@@angular/core");
  const outputSym = imp("output@@angular/core");
  const injectSym = imp("inject@@angular/core");
  const FormBuilderSym = imp("FormBuilder@@angular/forms");
  const ValidatorsSym = imp("Validators@@angular/forms");
  const ReactiveFormsModuleSym = imp("ReactiveFormsModule@@angular/forms");
  const CommonModuleSym = imp("CommonModule@@angular/common");
  const CurrencyInputComponentSym = imp("CurrencyInputComponent@@metaobjectsdev/angular");

  const controlEntries = fields.map((f) => {
    const validators = controlValidatorsFor(f);
    const validatorsExpr = validators.length > 0
      ? `[${validators.join(", ")}]`
      : "[]";
    return `      ${f.name}: [${controlDefaultFor(f)}, ${validatorsExpr}],`;
  }).join("\n");

  const templateFields = fields.map((f) => {
    const ctrlType = controlTypeFor(f);
    const labelText = f.name.charAt(0).toUpperCase() + f.name.slice(1);
    if (ctrlType === "checkbox") {
      return `        <label>${labelText}<input type="checkbox" [formControlName]="${JSON.stringify(f.name)}" /></label>`;
    }
    if (ctrlType === "currency") {
      return `        <label>${labelText}<mo-currency-input [formControlName]="${JSON.stringify(f.name)}"></mo-currency-input></label>`;
    }
    return `        <label>${labelText}<input type="text" [formControlName]="${JSON.stringify(f.name)}" /></label>`;
  }).join("\n");

  const literalImports = code`
import type { ${entityName} as ${entityName}Row } from ${JSON.stringify(entityFileSpec)};
`;

  const body = code`
/**
 * Generated Angular form component for ${entityName}. Reactive-forms based;
 * field controls + validators are derived from metadata. Replace by hand-writing
 * a custom component using the same building blocks if you need a richer layout.
 */
@${ComponentSym}({
  selector: ${JSON.stringify(`${entityName.toLowerCase()}-form`)},
  standalone: true,
  imports: [${CommonModuleSym}, ${ReactiveFormsModuleSym}, ${CurrencyInputComponentSym}],
  template: \`
    <form [formGroup]="form" (ngSubmit)="onSubmit()">
${templateFields}
      <button type="submit" [disabled]="form.invalid || form.pristine">Save</button>
    </form>
  \`,
})
export class ${entityName}FormComponent {
  private readonly fb = ${injectSym}(${FormBuilderSym});

  readonly entity = ${inputSym}<${entityName}Row | null>(null);
  readonly submitted = ${outputSym}<Partial<${entityName}Row>>();

  readonly form = this.fb.group({
${controlEntries}
  });

  onSubmit(): void {
    if (this.form.invalid) return;
    this.submitted.emit(this.form.value as Partial<${entityName}Row>);
  }
}
`;

  // Reference the imported Validators symbol so ts-poet emits the import
  // even though it appears only inside template strings above.
  const validatorsAnchor = code`
const __ensureValidatorsImport__ = ${ValidatorsSym};
void __ensureValidatorsImport__;
`;

  const header =
    `// ${GENERATED_HEADER}-angular — DO NOT EDIT.\n` +
    `// Source metadata: ${entityName} (${entity.fqn()})\n`;
  return header + literalImports.toString() + body.toString() + validatorsAnchor.toString();
}
