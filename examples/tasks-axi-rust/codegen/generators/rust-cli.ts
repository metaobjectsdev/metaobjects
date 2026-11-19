// OWNED GENERATOR (ADR-0034 Amendment 4) — emits the Rust source of the tasks-axi read path.
//
// Three layers, each replaceable on its own (a Rust-native generator keeps the middle one's
// shape and the committed goldens as its specification):
//   1. codegen/rust/read-model.ts   model  -> IR   (the only file that touches metadata classes)
//   2. codegen/rust/ir.ts           the intermediate description, plain data
//   3. codegen/rust/emit/*.ts       IR     -> text (one file per emitted Rust module)
//
// RUNTIME: runs under whatever runs `meta gen` (node for the published CLI) — no `Bun.*`.

import type { Generator } from "@metaobjectsdev/codegen-ts/engine";
import { emitCargo, emitLib } from "../rust/emit/crate.js";
import { emitCli } from "../rust/emit/cli.js";
import { emitDispatch } from "../rust/emit/dispatch.js";
import { emitEnums } from "../rust/emit/enums.js";
import { emitErrors } from "../rust/emit/errors.js";
import { emitModel } from "../rust/emit/model.js";
import { emitRows } from "../rust/emit/rows.js";
import { rustfmt } from "../rust/format.js";
import { readModel } from "../rust/read-model.js";

export function rustCli(): Generator {
  return {
    name: "rust-cli",
    generate(ctx) {
      const ir = readModel(ctx.loadedRoot);
      const rs = (path: string, text: string) => ({ path, content: rustfmt(text) });
      return [
        { path: "Cargo.toml", content: emitCargo() },
        rs("src/lib.rs", emitLib(ir)),
        rs("src/enums.rs", emitEnums(ir)),
        rs("src/model.rs", emitModel(ir)),
        rs("src/rows.rs", emitRows(ir)),
        rs("src/errors.rs", emitErrors(ir)),
        rs("src/cli.rs", emitCli(ir)),
        rs("src/dispatch.rs", emitDispatch(ir)),
      ];
    },
  };
}
