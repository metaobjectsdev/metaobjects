import type { MetaDataTypeProvider } from "../../provider.js";
import type { TypeRegistry } from "../../registry.js";
import { defineCommonAttrsFromData } from "../../provider-data.js";
import { DOCUMENTATION_DEFINITION } from "./documentation-definition.embedded.js";

export const docProvider: MetaDataTypeProvider = {
  id: "metaobjects-documentation",
  dependencies: ["metaobjects-core-types"],
  description: "Universal documentation common attrs (description / title / notes / deprecated / replacedBy / seeAlso / aliases) accepted on every metatype.",
  registerTypes(registry: TypeRegistry): void {
    registry.registerCommonAttrs(defineCommonAttrsFromData(DOCUMENTATION_DEFINITION));
  },
};
