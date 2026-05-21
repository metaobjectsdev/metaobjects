// DataType — a coarse, cross-cutting value-type classification.
//
// Java-`DataTypes` parity: a small closed set that both fields and attributes
// classify into (a `MetaField`/`MetaAttr` subtype maps to exactly one DataType).
// Registry-driven — a (type, subType)'s DataType is declared on its
// TypeDefinition, never in a central switch here. This module stays small and
// stable: just the union, its constants, and the DataTypeAware interface.

export const DATA_TYPE_BOOLEAN = "boolean";
export const DATA_TYPE_INT = "int";
export const DATA_TYPE_LONG = "long";
export const DATA_TYPE_DOUBLE = "double";
export const DATA_TYPE_STRING = "string";
export const DATA_TYPE_DATE = "date";
export const DATA_TYPE_OBJECT = "object";

/** The closed set of coarse value types. */
export const DATA_TYPES = [
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_STRING,
  DATA_TYPE_DATE,
  DATA_TYPE_OBJECT,
] as const;

export type DataType = (typeof DATA_TYPES)[number];

/** Implemented by nodes that carry a typed value — MetaField and MetaAttr. */
export interface DataTypeAware {
  readonly dataType: DataType;
}
