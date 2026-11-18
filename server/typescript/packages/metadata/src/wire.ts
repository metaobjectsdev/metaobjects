import type { MetaData } from "./shared/meta-data.js";

/**
 * The output form of a generated REST surface: the `wire` block of `.metaobjects/config.json`
 * (ADR-0019 Amendment 2). Like `naming`, the project-aware load sets it on the loaded root and
 * codegen reads it back through {@link wireFormatOf}. Input rules (a decimal body value is a
 * string or an exact number, over-scale is refused) do NOT follow it; only what is written does.
 */

/** `wire.decimals`: `native` = the string the in-process type holds, `string` = the canonical W1 string. */
export const WIRE_DECIMALS = ["native", "string"] as const;
export type WireDecimals = (typeof WIRE_DECIMALS)[number];

/** `wire.nullMembers`: how a null member of a value object is written. */
export const WIRE_NULL_MEMBERS = ["native", "emit", "omit"] as const;
export type WireNullMembers = (typeof WIRE_NULL_MEMBERS)[number];

/**
 * `wire.durations`: how a `field.duration` is written and read. `native` = the language's own
 * serializer for its duration type (System.Text.Json's `01:30:00` for a C# `TimeSpan`); `iso` =
 * canonical ISO-8601 (`PT1H30M`) in every port. TypeScript has no duration type, so it writes
 * ISO-8601 either way.
 */
export const WIRE_DURATIONS = ["native", "iso"] as const;
export type WireDurations = (typeof WIRE_DURATIONS)[number];

/** The keys of the `wire` block. */
export const WIRE_KEY_DECIMALS = "decimals";
export const WIRE_KEY_NULL_MEMBERS = "nullMembers";
export const WIRE_KEY_DURATIONS = "durations";

export const WIRE_DECIMALS_NATIVE: WireDecimals = "native";
export const WIRE_DECIMALS_STRING: WireDecimals = "string";
export const WIRE_NULL_MEMBERS_NATIVE: WireNullMembers = "native";
export const WIRE_NULL_MEMBERS_EMIT: WireNullMembers = "emit";
export const WIRE_NULL_MEMBERS_OMIT: WireNullMembers = "omit";
export const WIRE_DURATIONS_NATIVE: WireDurations = "native";
export const WIRE_DURATIONS_ISO: WireDurations = "iso";

export interface WireFormat {
  readonly decimals: WireDecimals;
  readonly nullMembers: WireNullMembers;
  readonly durations: WireDurations;
}

/** The default in every port: each language's own standard output. */
export const DEFAULT_WIRE_FORMAT: WireFormat = Object.freeze({
  decimals: WIRE_DECIMALS_NATIVE,
  nullMembers: WIRE_NULL_MEMBERS_NATIVE,
  durations: WIRE_DURATIONS_NATIVE,
});

/** The wire format for the tree `node` belongs to: what its root carries, else the default. */
export function wireFormatOf(node: MetaData): WireFormat {
  const wire = (node.root() as { wireFormat?: WireFormat }).wireFormat;
  return wire ?? DEFAULT_WIRE_FORMAT;
}
