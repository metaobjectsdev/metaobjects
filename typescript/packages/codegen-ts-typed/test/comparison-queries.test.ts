// Byte-identical comparison: POC queries vs codegen-ts queries.

import { describe, it, expect } from "bun:test";
import { makeRenderContext } from "../../codegen-ts/src/render-context.js";
import { buildPkMap as buildPkMapOld } from "../../codegen-ts/src/pk-resolver.js";
import { buildRelationMap as buildRelationMapOld } from "../../codegen-ts/src/relation-resolver.js";
import * as queriesOld from "../../codegen-ts/src/templates/queries.js";
import * as queriesNew from "../src/templates/queries.js";
import { buildPkMap as buildPkMapNew } from "../src/pk-resolver.js";
import { buildRelationMap as buildRelationMapNew } from "../src/relation-resolver.js";
import {
  loadModelRoot, loadMetaRoot,
  comparisonEntitiesAsModels, comparisonEntitiesAsObjects,
} from "./fixtures/comparison-metadata.ts";

const RENDERERS = [
  "renderFindByIdFn", "renderListFn", "renderCreateFn", "renderUpdateFn", "renderDeleteByIdFn",
] as const;
const DIALECTS = ["sqlite", "postgres"] as const;

describe("queries — POC output is byte-identical to codegen-ts", () => {
  for (const dialect of DIALECTS) {
    it(`every CRUD renderer matches for every entity (${dialect})`, () => {
      const modelRoot = loadModelRoot();
      const oldCtx = makeRenderContext({
        dialect, loadedRoot: modelRoot, outDir: "out", dbImport: "./db",
        pkMap: buildPkMapOld(modelRoot), relationMap: buildRelationMapOld(modelRoot),
      });
      const metaRoot = loadMetaRoot();
      const newCtx = {
        dialect, loadedRoot: metaRoot, outDir: "out", dbImport: "./db",
        omImport: "../index", extStyle: "none" as const,
        columnNamingStrategy: "snake_case" as const, apiPrefix: "",
        pkMap: buildPkMapNew(metaRoot), relationMap: buildRelationMapNew(metaRoot),
      };
      const oldEntities = comparisonEntitiesAsModels();
      const newEntities = comparisonEntitiesAsObjects();

      for (let i = 0; i < oldEntities.length; i++) {
        for (const r of RENDERERS) {
          const oldOut = (queriesOld as any)[r](oldEntities[i], oldCtx).toString();
          const newOut = (queriesNew as any)[r](newEntities[i], newCtx).toString();
          expect(newOut).toBe(oldOut);
        }
      }
    });
  }
});
