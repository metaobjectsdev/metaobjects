// FR-044 Plan 4, Table G — the SQL the Cube model carries. Cube reads every `sql` value twice
// before the database sees it: Jinja processes the YAML model, then Cube compiles the value as a
// JS template literal, where `{...}` is a member reference and a backslash is an escape (`\b` a
// backspace, `\_` a plain `_`; a trailing `\` swallows the closing quote, and `\u` with no hex
// digits fails the compile). So an identifier or a literal the exporter writes is SQL-quoted
// exactly as the report view lowering quotes it (report-sql.ts: `q`, `literal`), then escaped for
// both. The `{CUBE}`, `{Target}`, `{Target.member}` and `{member}` tokens the exporter inserts
// itself are never escaped. Relative dates are the view's own SQL (`relativeNowSql`), unchanged.

import { isRelativeNow } from "../projection/report-spec.js";
import { literal, q, ref, type SqlRenderer } from "../projection/report-sql.js";
import { CubeModelError, ERR_CUBE_UNESCAPABLE_LITERAL } from "./cube-errors.js";
import type { CubeDialect } from "./cube-model-spec.js";
import { escapeCubeTemplate, jinjaSafe, JINJA_RAW_END } from "./cube-template.js";

/** The owning cube, in a member's or a join's SQL. */
export const CUBE_SELF = "{CUBE}";

/**
 * Table G's rule for one SQL-quoted identifier or literal (cube-template.ts): backslashes doubled
 * and braces escaped for Cube's template reader, then, when the text holds a Jinja opener, the
 * whole token wrapped in `{% raw %}`. A wrapped token holding `endraw` cannot be carried: it
 * would end that raw block.
 */
function escapeToken(sql: string, kind: "identifier" | "literal", where: string): string {
  return jinjaSafe(sql, escapeCubeTemplate(sql), () =>
    new CubeModelError(
      ERR_CUBE_UNESCAPABLE_LITERAL,
      `${where}: the ${kind} ${sql} contains "${JINJA_RAW_END}", which would end the {% raw %} block ` +
        `that keeps Jinja away from it, so Cube cannot be given it intact. ` +
        (kind === "literal"
          ? `Change the value, or express the condition another way (for example a 'like' pattern).`
          : `Rename it in the model (@column, or the source's table or schema).`),
    ),
  );
}

/**
 * A renderer for `cond` / `ref` that writes Cube SQL. `where` names the node whose SQL it
 * renders, for the one token no escaping can carry.
 */
export function cubeSqlRenderer(where: string): SqlRenderer {
  return {
    identifier: (ident, d) => escapeToken(q(ident, d), "identifier", where),
    literal: (v, d) => {
      const sql = literal(v, d);
      // A relative date is the view's own SQL (`relativeNowSql`), written by the exporter.
      return isRelativeNow(v) ? sql : escapeToken(sql, "literal", where);
    },
  };
}

/** `{CUBE}."column"`: a column of the owning cube. */
export function cubeColumn(column: string, d: CubeDialect, renderer: SqlRenderer): string {
  return ref(`${CUBE_SELF}.${column}`, d, renderer);
}

/** `{Cube}."column"`: a column of a joined cube, inside a join's ON predicate. */
export function joinedColumn(cube: string, column: string, d: CubeDialect, renderer: SqlRenderer): string {
  return ref(`{${cube}}.${column}`, d, renderer);
}

/** `{Cube.member}`, or `{member}` on the owning cube: a reference to a member. */
export function memberRef(member: string, cube?: string): string {
  return cube === undefined ? `{${member}}` : `{${cube}.${member}}`;
}

/** `"table"`, or `"schema"."table"` when a schema is declared (Table B). */
export function tableRef(table: string, schema: string | undefined, d: CubeDialect, renderer: SqlRenderer): string {
  const t = renderer.identifier(table, d);
  return schema === undefined ? t : `${renderer.identifier(schema, d)}.${t}`;
}
