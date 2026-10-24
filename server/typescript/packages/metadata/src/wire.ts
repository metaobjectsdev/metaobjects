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

/** The keys of the `wire` block. */
export const WIRE_KEY_DECIMALS = "decimals";
export const WIRE_KEY_NULL_MEMBERS = "nullMembers";

export const WIRE_DECIMALS_NATIVE: WireDecimals = "native";
export const WIRE_DECIMALS_STRING: WireDecimals = "string";
export const WIRE_NULL_MEMBERS_NATIVE: WireNullMembers = "native";
export const WIRE_NULL_MEMBERS_EMIT: WireNullMembers = "emit";
export const WIRE_NULL_MEMBERS_OMIT: WireNullMembers = "omit";

export interface WireFormat {
  readonly decimals: WireDecimals;
  readonly nullMembers: WireNullMembers;
}

/** The default in every port: each language's own standard output. */
export const DEFAULT_WIRE_FORMAT: WireFormat = Object.freeze({
  decimals: WIRE_DECIMALS_NATIVE,
  nullMembers: WIRE_NULL_MEMBERS_NATIVE,
});

/** The wire format for the tree `node` belongs to: what its root carries, else the default. */
export function wireFormatOf(node: MetaData): WireFormat {
  const wire = (node.root() as { wireFormat?: WireFormat }).wireFormat;
  return wire ?? DEFAULT_WIRE_FORMAT;
}
