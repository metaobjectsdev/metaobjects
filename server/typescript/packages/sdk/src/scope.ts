// server/typescript/packages/sdk/src/scope.ts
//
// FR-023 §4.3 — the scope-pattern grammar moved to `@metaobjectsdev/metadata`
// (pure string code, browser-safe) so `codegen-ts` can use it without
// depending on sdk. Re-exported here unchanged so existing importers of the
// scope API from `@metaobjectsdev/sdk` — including this package's own
// `collection.ts` and `index.ts` — keep working without modification.
export { compileScope, matchesScope } from "@metaobjectsdev/metadata";
export type { Scope, CompiledScope } from "@metaobjectsdev/metadata";
