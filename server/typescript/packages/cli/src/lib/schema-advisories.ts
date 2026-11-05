// Advice from the schema diff that is not drift (migrate-ts `SchemaAdvisory`): `meta migrate`
// and `meta verify` print the same sentence for each.
import type { SchemaAdvisory } from "@metaobjectsdev/migrate-ts";

/** One sentence per advisory, each naming the column and what to do about it. */
export function schemaAdvisoryLines(advisories: readonly SchemaAdvisory[] | undefined): string[] {
  return (advisories ?? []).map((a) => {
    const t = a.schema !== undefined ? `${a.schema}.${a.table}` : a.table;
    switch (a.kind) {
      case "interval-as-string":
        return `${t}.${a.column} is a Postgres interval the metadata does not declare as a field.duration; `
          + `it is compared as text, so it is not drift. Model it as field.duration for the native type, `
          + `span ordering and range filters.`;
      case "sequence-not-applied":
        return `${t}.${a.column}: SQLite and D1 have no sequence, so the primary key's @sequenceStart / `
          + `@sequenceName is not applied and the key counts from 1.`;
    }
  });
}
