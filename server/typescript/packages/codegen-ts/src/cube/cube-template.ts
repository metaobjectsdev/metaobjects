// FR-044 Plan 4, Table G — the two readers every string in a Cube model passes through before the
// database or a client sees it, and the one rule for getting text past both. Cube runs Jinja over
// the whole YAML file first, then reads each `sql` value (as a JS template literal) and each
// `title` / `description` as a template, where `{...}` is a member reference and a backslash an
// escape. SQL (cube-sql.ts) and free text (cube-yaml.ts) use the same two steps, from here:
//
//   1. `escapeCubeTemplate`: every `\` doubled, THEN every `{` and `}` escaped. The order matters:
//      doubling after the braces would turn the `\{` just written into `\\{`, an escaped
//      backslash followed by a live brace.
//   2. `jinjaSafe`: when the ORIGINAL text holds a Jinja opener (`{{`, `{%` or `{#`), the escaped
//      text is wrapped in `{% raw %}...{% endraw %}`. A backslash does not stop Jinja, and step 1
//      leaves `{%` and `{#` intact inside `\{%` and `\{#`. Text that is wrapped and holds `endraw`
//      is refused: it is the one word that ends the raw block. Text that is not wrapped is never
//      inside one, so `endraw` there is plain text.

/** `{{`, `{%` or `{#`: text holding one is raw-wrapped for Jinja. */
export const JINJA_OPENER = /\{[{%#]/;

/** The word that would end a `{% raw %}` block early. */
export const JINJA_RAW_END = "endraw";

/** Step 1: text as Cube's template reader hands it back unchanged. */
export function escapeCubeTemplate(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, (brace) => `\\${brace}`);
}

/**
 * Step 2: `escaped` (step 1 applied to `original`), raw-wrapped when `original` holds a Jinja
 * opener. `refuse` builds the error thrown when that wrapped text holds `endraw`.
 */
export function jinjaSafe(original: string, escaped: string, refuse: () => Error): string {
  if (!JINJA_OPENER.test(original)) return escaped;
  if (original.includes(JINJA_RAW_END)) throw refuse();
  return `{% raw %}${escaped}{% endraw %}`;
}
