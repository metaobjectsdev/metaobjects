// Angular 18 form template — emits a per-entity standalone Component using
// Angular reactive forms (FormBuilder + Validators) and signal-based input
// for the entity-under-edit. Mirrors React's <Entity>Form.tsx.
//
// Visible-fields rules match the React generator:
//   - Primary-identity fields excluded (DB-generated)
//   - Fields with @formExclude: true excluded, and credential (view.password) fields
//   - Timestamp fields with default CURRENT_TIMESTAMP excluded (auto-managed)
//
// Form generation is OPT-IN at PROJECT level: add `angularFormFile()` to
// `generators` in metaobjects.config.ts, and narrow it to a subset with
// `angularFormFile({ filter })`. There is no `@emitAngular` metadata attribute
// — it was never registered vocabulary, so `meta verify` rejects it
// (ERR_UNKNOWN_ATTR); the line here used to claim it turned generation ON,
// while the factory beside it read it as an opt-OUT. Neither is true now.

import { arr, props, str, TsWriter } from "@metaobjectsdev/codegen-ts";
import { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
} from "@metaobjectsdev/metadata";
import { type RenderContext, GENERATED_HEADER, GENERATED_EDIT_NOTE, entityModuleSpecifier,
  effectivePackage, isCredentialField,
} from "@metaobjectsdev/codegen-ts";

function primaryFieldNames(entity: MetaObject): Set<string> {
  const set = new Set<string>();
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

function visibleFields(entity: MetaObject): MetaField[] {
  const pkNames = primaryFieldNames(entity);
  const out: MetaField[] = [];
  for (const child of entity.fields()) {
    // ADR-0039: resolving — a field may inherit @formExclude via extends.
    if (child.attr(FIELD_ATTR_FORM_EXCLUDE) === true) continue;
    // A credential is never edited through a generated form (see the React generator).
    if (isCredentialField(child)) continue;
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
    default: return str("");
  }
}

/** The control's validators; `validators` is the local name of the imported `Validators`,
 *  asked for only by a field that has one, so a form with none imports nothing unused. */
function controlValidatorsFor(field: MetaField, validators: () => string): string[] {
  const out: string[] = [];
  if (field.isRequired) out.push(`${validators()}.required`);
  // ADR-0039: resolving — a field may inherit @maxLength via extends.
  const max = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof max === "number") out.push(`${validators()}.maxLength(${max})`);
  return out;
}

function controlTypeFor(field: MetaField): string {
  if (field.subType === FIELD_SUBTYPE_BOOLEAN) return "checkbox";
  if (field.subType === FIELD_SUBTYPE_CURRENCY) return "currency";
  return "text";
}

/** The Angular form component for `entity`, as a file. */
export function renderFormFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeFormFile(w, entity, ctx);
  return w.toString();
}

/** Write the `<Entity>FormComponent` (reactive forms) for `entity` into `w`. */
export function writeFormFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  const entityFileSpec = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entityName,
    ctx.extStyle,
  );
  const fields = visibleFields(entity);

  w.header(
    `// ${GENERATED_HEADER}-angular — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
  );
  const row = w.useType(entityName, entityFileSpec, `${entityName}Row`);
  const validators = (): string => w.use("Validators", "@angular/forms");

  const controls = props();
  for (const f of fields) {
    controls.set(f.name, arr([controlDefaultFor(f), arr(controlValidatorsFor(f, validators))]));
  }

  w.blank();
  w.doc(
    `Generated Angular form component for ${entityName}. Reactive-forms based;`,
    "field controls + validators are derived from metadata. Replace by hand-writing",
    "a custom component using the same building blocks if you need a richer layout.",
  );
  w.block(`@${w.use("Component", "@angular/core")}({`, () => {
    w.line(`selector: ${str(`${entityName.toLowerCase()}-form`)},`);
    w.line("standalone: true,");
    w.line("imports: ", arr([
      w.use("CommonModule", "@angular/common"),
      w.use("ReactiveFormsModule", "@angular/forms"),
      w.use("CurrencyInputComponent", "@metaobjectsdev/angular"),
    ]), ",");
    // The component template is one template literal; its markup nests like any block.
    w.block("template: `", () => {
      w.block('<form [formGroup]="form" (ngSubmit)="onSubmit()">', () => {
        for (const f of fields) {
          const ctrlType = controlTypeFor(f);
          const labelText = f.name.charAt(0).toUpperCase() + f.name.slice(1);
          // A static control name binds as a plain attribute: `[formControlName]` would need a
          // quoted string expression inside the attribute's own quotes.
          const control = `formControlName="${f.name}"`;
          if (ctrlType === "checkbox") {
            w.line(`<label>${labelText}<input type="checkbox" ${control} /></label>`);
          } else if (ctrlType === "currency") {
            w.line(`<label>${labelText}<mo-currency-input ${control}></mo-currency-input></label>`);
          } else {
            w.line(`<label>${labelText}<input type="text" ${control} /></label>`);
          }
        }
        w.line('<button type="submit" [disabled]="form.invalid || form.pristine">Save</button>');
      }, "</form>");
    }, "`,");
  }, "})");
  w.block(`export class ${entityName}FormComponent {`, () => {
    w.line(`private readonly fb = ${w.use("inject", "@angular/core")}(${w.use("FormBuilder", "@angular/forms")});`);
    w.blank();
    w.line(`readonly entity = ${w.use("input", "@angular/core")}<${row} | null>(null);`);
    w.line(`readonly submitted = ${w.use("output", "@angular/core")}<Partial<${row}>>();`);
    w.blank();
    w.line("readonly form = this.fb.group(", controls, ");");
    w.blank();
    w.block("onSubmit(): void {", () => {
      w.block("if (this.form.invalid) {", () => w.line("return;"));
      w.line(`this.submitted.emit(this.form.value as Partial<${row}>);`);
    });
  });
}
