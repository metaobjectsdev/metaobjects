// The rules names file of one metadata package (ADR-0067 §1, layer 0): its lifecycles'
// states and transitions, its derived commands, its declared operations, the permissions they
// ask about and the business errors its commands declare, as `as const` values and the literal
// unions read off them.
//
// This is the emit step only. What the names ARE comes from `rulesNamesOf` (engine), which
// reads the same derivations `meta verify`'s rules gate checks; change the file's shape here
// and keep that walk, so a constant and a verify message never name two different things.

import { GENERATED_EDIT_NOTE, GENERATED_HEADER } from "../constants.js";
import { toPascalCase } from "../naming.js";
import { SHELL_ERROR_CODES, type RulesNamesEntity, type RulesNamesPackage } from "../rules-walk.js";
import { TsWriter, arr, key, props, str } from "../writer/ts-writer.js";

const strings = (values: readonly string[]) => arr(values.map(str));

/** `<Entity><Field>Lifecycle`: the constant one lifecycle is written to. */
export function lifecycleConstName(entity: string, field: string): string {
  return `${entity}${toPascalCase(field)}Lifecycle`;
}

function writeEntity(w: TsWriter, e: RulesNamesEntity): void {
  for (const l of e.lifecycles) {
    const name = lifecycleConstName(e.name, l.field);
    const stem = name.slice(0, -"Lifecycle".length);
    w.blank().doc(`The lifecycle of ${e.name}.${l.field}: its states, initial and terminal states, and transitions.`);
    w.block(`export const ${name} = {`, () => {
      w.line(`field: ${str(l.field)},`);
      w.line("states: ", strings(l.states), ",");
      if (l.initial !== undefined) w.line(`initial: ${str(l.initial)},`);
      w.line("terminal: ", strings(l.terminal), ",");
      w.block("transitions: {", () => {
        for (const t of l.transitions) {
          const body = props().set("from", strings(t.from));
          if (t.to !== undefined) body.set("to", str(t.to));
          w.line(`${key(t.name)}: `, body, ",");
        }
      }, "},");
    }, "} as const;");
    w.line(`export type ${stem}State = (typeof ${name}.states)[number];`);
    w.line(`export type ${stem}Transition = keyof typeof ${name}.transitions;`);
  }
  if (e.commands.length === 0) return;
  w.blank().doc(
    `The commands derived from ${e.name}'s transitions (ADR-0066 §2): each takes the key and makes`,
    "its transition. `permission` is what the shell asks the policy; `public` means it asks nothing.",
  );
  w.block(`export const ${e.name}Commands = {`, () => {
    for (const c of e.commands) {
      const body = props().set("lifecycle", str(c.lifecycle));
      if (c.permission === undefined) body.set("public", "true");
      else body.set("permission", str(c.permission));
      w.line(`${key(c.name)}: `, body, ",");
    }
  }, "} as const;");
  w.line(`export type ${e.name}Command = keyof typeof ${e.name}Commands;`);
}

/** The text of one package's `rules.names.ts`. */
export function renderRulesNames(pkg: RulesNamesPackage): string {
  const w = new TsWriter();
  w.header(
    `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: rules of ${pkg.package === "" ? "the model" : `package ${pkg.package}`}`,
  );

  w.doc("The wire codes the enforcing shell answers with on its own (ADR-0066 §6).");
  w.line("export const ShellErrors = ", strings(SHELL_ERROR_CODES), " as const;");
  w.line("export type ShellError = (typeof ShellErrors)[number];");

  for (const e of pkg.entities) writeEntity(w, e);

  if (pkg.operations.length > 0) {
    w.blank().doc("The package's declared operations, with the permission each asks about.");
    w.block("export const Operations = {", () => {
      for (const o of pkg.operations) {
        const body = props().set("kind", str(o.kind));
        if (o.permission === undefined) body.set("public", "true");
        else body.set("permission", str(o.permission));
        if (o.transitions.length > 0) body.set("transitions", strings(o.transitions));
        if (o.errors.length > 0) body.set("errors", strings(o.errors));
        w.line(`${key(o.name)}: `, body, ",");
      }
    }, "} as const;");
    w.line("export type Operation = keyof typeof Operations;");
  }

  w.blank().doc("Every permission a point of this package asks about: what a grant table names.");
  w.line("export const Permissions = ", strings(pkg.permissions), " as const;");
  w.line("export type Permission = (typeof Permissions)[number];");

  w.blank().doc("The business errors this package's commands declare (`@errors`).");
  w.line("export const BusinessErrors = ", strings(pkg.errors), " as const;");
  w.line("export type BusinessError = (typeof BusinessErrors)[number];");

  return w.toString();
}
