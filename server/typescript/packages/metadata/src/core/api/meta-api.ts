// Node classes for the declared API surface (ADR-0030, ADR-0066): `api.*`,
// `operation.*` and `binding.*`. Accessors are RESOLVING (ADR-0039), so an
// operation that `extends` another reads the inherited attributes.

import { MetaData } from "../../shared/meta-data.js";
import { TYPE_BINDING, TYPE_OPERATION } from "../../shared/base-types.js";
import {
  BINDING_ATTR_METHOD,
  BINDING_ATTR_PATH,
  OPERATION_ATTR_ERRORS,
  OPERATION_ATTR_INPUT_REF,
  OPERATION_ATTR_MANY,
  OPERATION_ATTR_OBJECT_REF,
  OPERATION_ATTR_OUTPUT_REF,
  OPERATION_ATTR_PERMISSION,
  OPERATION_ATTR_PUBLIC,
  OPERATION_ATTR_TRANSITIONS,
} from "./api-constants.js";

function stringAttr(node: MetaData, name: string): string | undefined {
  const v = node.attr(name);
  return typeof v === "string" ? v : undefined;
}

/** A bare string authored for an array attr is ONE element (the attr-schema rule). */
function stringArrayAttr(node: MetaData, name: string): readonly string[] {
  const v = node.attr(name);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** `api.operational` — a named surface whose children are operations. */
export class MetaApi extends MetaData {
  operations(): MetaOperation[] {
    return this.childrenOfType(TYPE_OPERATION).filter((c): c is MetaOperation => c instanceof MetaOperation);
  }
}

/** `operation.command` / `operation.query`. */
export class MetaOperation extends MetaData {
  inputRef(): string | undefined {
    return stringAttr(this, OPERATION_ATTR_INPUT_REF);
  }
  outputRef(): string | undefined {
    return stringAttr(this, OPERATION_ATTR_OUTPUT_REF);
  }
  objectRef(): string | undefined {
    return stringAttr(this, OPERATION_ATTR_OBJECT_REF);
  }
  transitions(): readonly string[] {
    return stringArrayAttr(this, OPERATION_ATTR_TRANSITIONS);
  }
  errors(): readonly string[] {
    return stringArrayAttr(this, OPERATION_ATTR_ERRORS);
  }
  permission(): string | undefined {
    return stringAttr(this, OPERATION_ATTR_PERMISSION);
  }
  isPublic(): boolean {
    return this.attr(OPERATION_ATTR_PUBLIC) === true;
  }
  isMany(): boolean {
    return this.attr(OPERATION_ATTR_MANY) === true;
  }
  bindings(): MetaBinding[] {
    return this.childrenOfType(TYPE_BINDING).filter((c): c is MetaBinding => c instanceof MetaBinding);
  }
}

/** `binding.rest`. */
export class MetaBinding extends MetaData {
  method(): string | undefined {
    return stringAttr(this, BINDING_ATTR_METHOD);
  }
  path(): string | undefined {
    return stringAttr(this, BINDING_ATTR_PATH);
  }
}
