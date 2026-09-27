/**
 * The SQL dialects the runtime mounts and drivers speak. `mysql` is a codegen + runtime dialect
 * only: MetaObjects does not own a MySQL schema (`meta migrate` supports Postgres, SQLite and
 * D1), so the adopter writes the DDL.
 */
export type SqlDialect = "sqlite" | "postgres" | "mysql";

/** Whether the dialect's INSERT / UPDATE / DELETE can return rows (`RETURNING`). MySQL cannot. */
export function supportsReturning(dialect: SqlDialect | undefined): boolean {
  return dialect !== "mysql";
}

/** Quote an identifier for raw SQL: backticks on MySQL, double quotes elsewhere. */
export function quoteIdent(dialect: SqlDialect | undefined, name: string): string {
  if (dialect === "mysql") {
    if (name.includes("`")) throw new Error(`unsafe identifier: ${name}`);
    return `\`${name}\``;
  }
  if (name.includes('"')) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
