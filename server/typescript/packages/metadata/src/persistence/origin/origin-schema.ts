// Origin attribute schemas — per-subtype attr inventories for origin types.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../../core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../../shared/base-types.js";
import {
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COLLECTION,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_COLLECTION_ATTR_VIA,
  AGGREGATE_FUNCTIONS,
} from "./origin-constants.js";

/** Attrs on origin.passthrough — @from is required. */
const passthroughOriginAttrs: AttrSchema[] = [
  {
    name: ORIGIN_PASSTHROUGH_ATTR_FROM,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title').",
  },
  {
    name: ORIGIN_PASSTHROUGH_ATTR_VIA,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks').",
  },
];

/** Attrs on origin.aggregate — @agg, @of, @via all required. */
const aggregateOriginAttrs: AttrSchema[] = [
  {
    name: ORIGIN_AGGREGATE_ATTR_AGG,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    allowedValues: [...AGGREGATE_FUNCTIONS],
    description: "Aggregate function applied over the relationship path: count, sum, avg, min, or max.",
  },
  {
    name: ORIGIN_AGGREGATE_ATTR_OF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes').",
  },
  {
    name: ORIGIN_AGGREGATE_ATTR_VIA,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts').",
  },
];

/** Attrs on origin.collection — @via (the relationship path) is required. */
const collectionOriginAttrs: AttrSchema[] = [
  {
    name: ORIGIN_COLLECTION_ATTR_VIA,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Dotted relationship path the collection walks to produce an array of nested view-objects (e.g. 'Author.posts'), or a wildcard selector for a package-spanning collection (e.g. '*.User').",
  },
];

/** Attrs per origin subtype. base has none; the others carry their respective attrs. */
export const ORIGIN_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [ORIGIN_SUBTYPE_PASSTHROUGH, [...passthroughOriginAttrs]],
  [ORIGIN_SUBTYPE_AGGREGATE, [...aggregateOriginAttrs]],
  [ORIGIN_SUBTYPE_COLLECTION, [...collectionOriginAttrs]],
]);
