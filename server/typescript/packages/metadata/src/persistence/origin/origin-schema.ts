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

/** Attrs on origin.aggregate — @agg and @of required; @via omissible since
 *  FR-024 (ADR-0029 decision 5: single-hop-unique inference from the base
 *  entity). NOTE: the cross-port registry manifest still records @via as
 *  required until the FR-024 Phase-E atomic flip — see
 *  FR024_PENDING_REQUIRED_OVERRIDES in registry-manifest-exclusions.ts. */
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
    required: false,
    description:
      "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts'). May be omitted only when exactly one single-hop relationship leads from the base entity to the @of entity (FR-024, ADR-0029).",
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
