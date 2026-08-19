// server/typescript/packages/sdk/test/support/error-code.ts
//
// Shared by scope.test.ts, sources.test.ts and collection.test.ts. Each used
// to define its own copy of these two helpers, cross-referencing the others
// in a comment as the only sync mechanism — one copy, imported by all three.
//
// Property-based, never message-matching or `instanceof`: a cross-package
// `instanceof ParseError` is silently false when two physical copies of
// `@metaobjectsdev/metadata` are loaded (a globally-installed or linked CLI
// alongside a project-local dependency), so `.code` is the only reliable
// read.

/** Pull the stable ERR_ code off a caught error, if it carries one. */
export function errorCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "ERR_UNKNOWN";
}

/** Await `promise`, expecting it to reject — returns the rejection's stable
 *  code. */
export async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return errorCode(err);
  }
  throw new Error("expected the promise to reject, but it resolved");
}
