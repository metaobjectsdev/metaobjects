// Byte-identical comparison: POC entity-file vs codegen-ts entity-file.
// The comparison fixture has no projections, so both render the vanilla path.

import { describe, it, expect } from "bun:test";
import { makeRenderContext } from "../../codegen-ts/src/render-context.js";
import { buildPkMap as buildPkMapOld } from "../../codegen-ts/src/pk-resolver.js";
import { buildRelationMap as buildRelationMapOld } from "../../codegen-ts/src/relation-resolver.js";
import { renderEntityFile as renderOld } from "../../codegen-ts/src/templates/entity-file.js";
import { renderEntityFile as renderNew } from "../src/templates/entity-file.js";
import { buildPkMap as buildPkMapNew } from "../src/pk-resolver.js";
import { buildRelationMap as buildRelationMapNew } from "../src/relation-resolver.js";
import {
  loadModelRoot, loadMetaRoot,
  comparisonEntitiesAsModels, comparisonEntitiesAsObjects,
} from "./fixtures/comparison-metadata.ts";

const DIALECTS = ["sqlite", "postgres"] as const;

describe("entity-file — POC output is byte-identical to codegen-ts", () => {
  for (const dialect of DIALECTS) {
    it(`matches for every comparison entity (${dialect})`, async () => {
      const modelRoot = await loadModelRoot();
      const oldCtx = makeRenderContext({
        dialect, loadedRoot: modelRoot, outDir: "out", dbImport: "./db",
        pkMap: buildPkMapOld(modelRoot), relationMap: buildRelationMapOld(modelRoot),
      });
      const metaRoot = await loadMetaRoot();
      const newCtx = {
        dialect, loadedRoot: metaRoot, outDir: "out", dbImport: "./db",
        omImport: "../index", extStyle: "none" as const,
        columnNamingStrategy: "snake_case" as const, apiPrefix: "",
        pkMap: buildPkMapNew(metaRoot), relationMap: buildRelationMapNew(metaRoot),
      };
      const oldEntities = await comparisonEntitiesAsModels();
      const newEntities = await comparisonEntitiesAsObjects();

      for (let i = 0; i < oldEntities.length; i++) {
        const oldOut = renderOld(oldEntities[i]!, oldCtx);
        const newOut = renderNew(newEntities[i]!, newCtx);
        expect(newOut).toBe(oldOut);
      }
    });
  }
});
