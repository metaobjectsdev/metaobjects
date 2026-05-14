// Reference-string format ("Entity:pk" or "Entity:pk1,pk2") mirrors Java's getObjectByRef.
// PK values containing commas are not supported in v0.1 — commas are the composite separator.

import { MetadataError, UnsafeNameError } from "./errors.js";
import { REF_SEPARATOR, REF_PK_SEPARATOR, VALID_ENTITY_NAME } from "./constants.js";

export interface DecodedRef {
  entity: string;
  /** PK values come back as strings; caller coerces back to number/etc. per metadata. */
  pkValues: string[];
}

export function encodeRef(entity: string, record: Record<string, unknown>, pkFields: string[]): string {
  if (!VALID_ENTITY_NAME.test(entity)) {
    throw new UnsafeNameError(
      `Unsafe entity name '${entity}' — must match ${VALID_ENTITY_NAME}`,
      { value: entity },
    );
  }
  if (pkFields.length === 0) {
    throw new MetadataError(`No primary-key fields declared for entity '${entity}'`, { entity });
  }
  const values: string[] = [];
  for (const field of pkFields) {
    const value = record[field];
    if (value === undefined || value === null) {
      throw new MetadataError(
        `Missing PK field '${field}' on record while encoding ref for '${entity}'`,
        { entity },
      );
    }
    const str = String(value);
    if (str.includes(REF_PK_SEPARATOR)) {
      throw new MetadataError(
        `PK value for '${field}' on '${entity}' contains '${REF_PK_SEPARATOR}' — reserved as the composite-PK separator in ref strings`,
        { entity },
      );
    }
    values.push(str);
  }
  return `${entity}${REF_SEPARATOR}${values.join(REF_PK_SEPARATOR)}`;
}

export function decodeRef(refString: string): DecodedRef {
  const sepIdx = refString.indexOf(REF_SEPARATOR);
  if (sepIdx <= 0) {
    throw new MetadataError(
      `Reference string '${refString}' missing '${REF_SEPARATOR}' separator`,
    );
  }
  const entity = refString.slice(0, sepIdx);
  const pkPart = refString.slice(sepIdx + 1);
  if (!VALID_ENTITY_NAME.test(entity)) {
    throw new UnsafeNameError(
      `Unsafe entity name '${entity}' in reference '${refString}'`,
      { value: entity },
    );
  }
  if (pkPart.length === 0) {
    throw new MetadataError(`Reference string '${refString}' has empty PK part`, { entity });
  }
  const pkValues = pkPart.split(REF_PK_SEPARATOR);
  return { entity, pkValues };
}
