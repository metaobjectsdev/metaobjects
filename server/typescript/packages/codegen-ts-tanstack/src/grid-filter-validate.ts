/**
 * Minimal local types mirroring FilterAllowlist from @metaobjectsdev/runtime-ts/drizzle-fastify.
 * Inlined so codegen-ts-tanstack doesn't need a runtime-ts dependency.
 */
export interface FilterFieldRule {
  readonly ops: readonly string[];
  readonly subType: string;
  readonly leadingWildcard: boolean;
}

export type FilterAllowlist = Readonly<Record<string, FilterFieldRule>>;

/**
 * Validate a data-grid `@filter` value against the entity's FilterAllowlist.
 * Returns an array of error messages (empty if all valid).
 *
 * Recurses through or/and composition. Reuses the same validation rules the
 * server-side parseFilterParams applies at runtime — but here it runs at codegen
 * time so authors get errors before the metadata reaches production.
 */
export function validateGridFilter(
  filter: Record<string, unknown>,
  allowlist: FilterAllowlist,
  contextLabel: string,
): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "or" || key === "and") {
      const subs = Array.isArray(value) ? value : [];
      for (const sub of subs) {
        errors.push(...validateGridFilter(sub as Record<string, unknown>, allowlist, contextLabel));
      }
      continue;
    }
    const rule = allowlist[key];
    if (!rule) {
      errors.push(
        `[grid-filter] ${contextLabel} @filter references disallowed field "${key}". ` +
        `Allowed: ${Object.keys(allowlist).join(", ") || "(no filterable fields)"}`,
      );
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const op of Object.keys(value)) {
        if (!rule.ops.includes(op)) {
          errors.push(
            `[grid-filter] ${contextLabel} @filter references disallowed (field, op) "${key}.${op}". ` +
            `Allowed ops for ${key}: ${rule.ops.join(", ")}`,
          );
        }
      }
    }
    // bare value → eq sugar. eq is always allowed (every subtype includes it).
  }
  return errors;
}
