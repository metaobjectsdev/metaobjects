// server/typescript/packages/cli/src/lib/package-name.ts

/** The package an import specifier names: `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}
