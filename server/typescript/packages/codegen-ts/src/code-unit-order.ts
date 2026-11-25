/**
 * Code-unit order: the same in every runtime, locale and language port, unlike
 * `localeCompare`, whose collation differs between machines. Use it for any order a shared
 * corpus pins.
 */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
