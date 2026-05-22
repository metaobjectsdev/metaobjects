// FilterAttr — attr subtype `filter`. Object-shaped value; desugars a preset
// filter to canonical `{ field: { op: value } }` form (scalar→eq, array→in,
// null→isNull; or/and recurse). Moved here from parser-core.ts
// `normalizeFilterAttr` / `desugarFilterObject` / `desugarClause`.

import { MetaAttr, type ValueError, runtimeTypeName } from "./meta-attr.js";
import { type AttrValue, type AttrObject, type AttrJson } from "./meta-data.js";
import { DATA_TYPE_OBJECT, type DataType } from "../data-type.js";
import {
  ATTR_SUBTYPE_FILTER,
  FILTER_OP_EQ,
  FILTER_OP_IN,
  FILTER_OP_IS_NULL,
  FILTER_COMPOSE_OR,
  FILTER_COMPOSE_AND,
} from "../constants.js";
import { registerAttrClass } from "../attr-class-map.js";

export class FilterAttr extends MetaAttr {
  override get dataType(): DataType {
    return DATA_TYPE_OBJECT;
  }

  override coerce(raw: unknown): AttrValue {
    // Object stored verbatim; a non-object (e.g. a legacy JSON string) is
    // returned as-is so validateValue rejects it.
    return typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as AttrValue)
      : (raw as AttrValue);
  }

  override desugar(value: AttrValue): AttrValue {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    return desugarFilterObject(value as AttrObject);
  }

  override validateValue(value: AttrValue): ValueError[] {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? []
      : [{ message: `attribute '@${this.name}' must be of type 'filter' but got ${runtimeTypeName(value)}` }];
  }
}

function desugarFilterObject(filter: AttrObject): AttrObject {
  const out: Record<string, AttrJson> = {};
  for (const [key, raw] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      out[key] = Array.isArray(raw)
        ? raw.map((sub: AttrJson) =>
            typeof sub === "object" && sub !== null && !Array.isArray(sub)
              ? desugarFilterObject(sub as AttrObject)
              : sub,
          )
        : (raw as AttrJson);
      continue;
    }
    out[key] = desugarClause(raw);
  }
  return out;
}

function desugarClause(raw: AttrJson): AttrObject {
  if (raw === null) return { [FILTER_OP_IS_NULL]: true };
  if (Array.isArray(raw)) return { [FILTER_OP_IN]: raw };
  if (typeof raw === "object") return raw as AttrObject;
  return { [FILTER_OP_EQ]: raw };
}

registerAttrClass(ATTR_SUBTYPE_FILTER, FilterAttr);
