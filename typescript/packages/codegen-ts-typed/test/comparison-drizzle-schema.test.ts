// Byte-identical comparison: POC drizzle-schema vs codegen-ts drizzle-schema.

import { describe, it, expect } from "bun:test";
import { makeRenderContext } from "../../codegen-ts/src/render-context.js";
import { buildPkMap as buildPkMapOld } from "../../codegen-ts/src/pk-resolver.js";
import { buildRelationMap as buildRelationMapOld } from "../../codegen-ts/src/relation-resolver.js";
import { renderDrizzleSchema as renderOld } from "../../codegen-ts/src/templates/drizzle-schema.js";
import { renderDrizzleSchema as renderNew } from "../src/templates/drizzle-schema.js";
import { buildPkMap as buildPkMapNew } from "../src/pk-resolver.js";
import { buildRelationMap as buildRelationMapNew } from "../src/relation-resolver.js";
import {
  loadModelRoot, loadMetaRoot,
  comparisonEntitiesAsModels, comparisonEntitiesAsObjects,
} from "./fixtures/comparison-metadata.ts";

const DIALECTS = ["sqlite", "postgres"] as const;

describe("drizzle-schema — POC output is byte-identical to codegen-ts", () => {
  for (const dialect of DIALECTS) {
    it(`matches for every comparison entity (${dialect})`, () => {
      const modelRoot = loadModelRoot();
      const oldCtx = makeRenderContext({
        dialect,
        loadedRoot: modelRoot,
        outDir: "out",
        dbImport: "./db",
        pkMap: buildPkMapOld(modelRoot),
        relationMap: buildRelationMapOld(modelRoot),
      });
      const metaRoot = loadMetaRoot();
      const newCtx = {
        dialect,
        loadedRoot: metaRoot,
        outDir: "out",
        dbImport: "./db",
        omImport: "../index",
        extStyle: "none" as const,
        columnNamingStrategy: "snake_case" as const,
        apiPrefix: "",
        pkMap: buildPkMapNew(metaRoot),
        relationMap: buildRelationMapNew(metaRoot),
      };

      const oldEntities = comparisonEntitiesAsModels();
      const newEntities = comparisonEntitiesAsObjects();
      expect(newEntities.map((e) => e.name)).toEqual(oldEntities.map((e) => e.name));

      for (let i = 0; i < oldEntities.length; i++) {
        const oldOut = renderOld(oldEntities[i]!, oldCtx).toString();
        const newOut = renderNew(newEntities[i]!, newCtx).toString();
        expect(newOut).toBe(oldOut);
      }
    });
  }
});
