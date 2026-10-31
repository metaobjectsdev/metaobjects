// FR-022 — the contract emitters' own errors. These are generator errors, printed in the message;
// they are not loader codes and are not listed in fixtures/conformance/ERROR-CODES.json.

/** Two objects would take the same OpenAPI component name. */
export const ERR_CONTRACT_NAME_COLLISION = "ERR_CONTRACT_NAME_COLLISION";
/** A strict schema was asked for a shape the strict subset cannot state (a map, an open object, a cycle). */
export const ERR_CONTRACT_STRICT_UNREPRESENTABLE = "ERR_CONTRACT_STRICT_UNREPRESENTABLE";

export const CONTRACT_ERROR_CODES = [
  ERR_CONTRACT_NAME_COLLISION,
  ERR_CONTRACT_STRICT_UNREPRESENTABLE,
] as const;
export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

export class ContractEmitError extends Error {
  readonly code: ContractErrorCode;

  constructor(code: ContractErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ContractEmitError";
    this.code = code;
  }
}
