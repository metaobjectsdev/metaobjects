import { describe, test } from "bun:test";

// XFAIL: codegen-ts v0.1 doesn't ship true 3-way merge yet. SP5's CLI maps
// --merge three-way to skip-existing semantics with a warning (see commands/
// gen.ts). True 3-way merge with hand-edit preservation is a v0.3 codegen-ts
// task. This test placeholder documents the intent; revisit once codegen-ts
// adds the real merge feature. Per SP5 §8.4 caveat.
describe.skip("meta gen --merge three-way (codegen-ts v0.3+ feature)", () => {
  test("first gen writes; hand-edit survives second gen after metadata mutation", () => {
    // To be enabled when codegen-ts gains true 3-way merge.
  });
});
