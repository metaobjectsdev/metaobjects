// reportingProvider — the reporting pack (FR-044): `object.report` and the
// dimension / measure / segment vocabulary a report is built from, plus the `@segment`
// attribute that lets an `origin.aggregate` or `origin.first` reuse a segment.
//
// It is its OWN provider rather than part of metaobjects-core-types so a project can
// leave it out and the vocabulary can move or be versioned on its own. It is in the
// default bundle (`coreProviders`), so every existing model loads unchanged.
// GOVERNANCE.md ("Extension packs and the core metamodel"): vocabulary lives in a
// pack until a second consumer needs it in core.
//
// The pack owns its types (reporting.json) AND the rules that admit them on types
// core owns: `object.entity` holds dimensions, measures and segments, and
// `origin.aggregate` / `origin.first` carry `@segment` — all in the file's `extends`.
// `object.report` folds in the `object.base` core registered (`extendsBase`). Compose
// the pack out and `object.report`, `dimension.*`, `measure.*` and `segment.*` are
// unknown (ERR_UNKNOWN_SUBTYPE / ERR_UNKNOWN_TYPE) and `@segment` is ERR_UNKNOWN_ATTR.

import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry, TypeId } from "../../registry.js";
import { applyProviderDefinition, type FactoryMap } from "../../provider-data.js";
import { TYPE_OBJECT, TYPE_DIMENSION, TYPE_MEASURE } from "../../shared/base-types.js";
import { MetaObject } from "../object/meta-object.js";
import { MetaDimension } from "./meta-dimension.js";
import { MetaMeasure } from "./meta-measure.js";
import { MetaSegment } from "./meta-segment.js";
import { REPORTING_DEFINITION } from "./reporting-definition.embedded.js";

/** The reporting pack's provider id (a logical id, shared by every port). */
export const REPORTING_PROVIDER_ID = "metaobjects-reporting";

export const reportingProvider: MetaDataTypeProvider = {
  id: REPORTING_PROVIDER_ID,
  dependencies: ["metaobjects-core-types"],
  description:
    "Reporting (FR-044): object.report, dimension / measure / segment on an entity, and @segment on origin.aggregate and origin.first.",
  registerTypes(registry: TypeRegistry): void {
    const factories: FactoryMap = {};
    for (const def of REPORTING_DEFINITION.types ?? []) {
      const key = `${def.type}.${def.subType}`;
      if (def.type === TYPE_OBJECT) factories[key] = (typeId: TypeId, name: string) => new MetaObject(typeId, name);
      else if (def.type === TYPE_DIMENSION) factories[key] = (typeId: TypeId, name: string) => new MetaDimension(typeId, name);
      else if (def.type === TYPE_MEASURE) factories[key] = (typeId: TypeId, name: string) => new MetaMeasure(typeId, name);
      else factories[key] = (typeId: TypeId, name: string) => new MetaSegment(typeId, name);
    }
    applyProviderDefinition(registry, REPORTING_DEFINITION, factories);
  },
};
