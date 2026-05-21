export const DEFAULT_IF_MISSING = "throw" as const;

// Mirrors SP2's path-traversal guard — entity names appear in filesystem paths.
export const VALID_ENTITY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const REF_SEPARATOR = ":";
export const REF_PK_SEPARATOR = ",";
