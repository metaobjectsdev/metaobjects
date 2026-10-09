// FR-044 Plan 4, Table G — the SQL the Cube model carries. Cube reads every `sql` value twice
// before the database sees it: Jinja processes the YAML model, then Cube's own `{...}` member
// reference syntax. So an identifier or a literal the exporter writes is SQL-quoted exactly as
// the report view lowering quotes it (report-sql.ts: `q`, `literal`), then escaped for both.
// The `{CUBE}`, `{Target}`, `{Target.member}` and `{member}` tokens the exporter inserts itself
// are never escaped. Relative dates are the view's own SQL (`relativeNowSql`), unchanged.

import { isRelativeNow } from "../projection/report-spec.js";
import { literal, q, ref, type SqlRenderer } from "../projection/report-sql.js";
import { CubeModelError, ERR_CUBE_UNESCAPABLE_LITERAL } from "./cube-errors.js";
import type { CubeDialect } from "./cube-model-spec.js";

/** The owning cube, in a member's or a join's SQL. */
export const CUBE_SELF = "{CUBE}";

/** `{` and `}` as Cube's reference syntax reads them literally. */
export function escapeCubeBraces(sql: string): string {
  return sql.replace(/[{}]/g, (brace) => `\\${brace}`);
}

const JINJA_OPENER = /\{[%#]/;
const JINJA_RAW_END = "endraw";

/**
 * A renderer for `cond` / `ref` that writes Cube SQL. `where` names the node whose SQL it
 * renders, for the one literal no escaping can carry.
 */
export function cubeSqlRenderer(where: string): SqlRenderer {
  return {
    identifier: (ident, d) => escapeCubeBraces(q(ident, d)),
    literal: (v, d) => {
      const sql = literal(v, d);
      if (isRelativeNow(v)) return sql;
      if (sql.includes(JINJA_RAW_END)) {
        throw new CubeModelError(
          ERR_CUBE_UNESCAPABLE_LITERAL,
          `${where}: the literal ${sql} contains "${JINJA_RAW_END}", which would end the ` +
            `{% raw %} block that keeps Jinja away from a literal, so Cube cannot be given it intact. ` +
            `Change the value, or express the condition another way (for example a 'like' pattern).`,
        );
      }
      const escaped = escapeCubeBraces(sql);
      // A backslash does not stop Jinja: a literal holding `{%` or `{#` is wrapped whole.
      return JINJA_OPENER.test(sql) ? `{% raw %}${escaped}{% endraw %}` : escaped;
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
