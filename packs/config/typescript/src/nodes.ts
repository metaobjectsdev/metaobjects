/**
 * The node classes for the types this pack owns outright. A settings group is a plain
 * `MetaObject` (core's class), so every object-walking reader in core sees it as one.
 *
 * Code outside this package never `instanceof`s these: two copies of the pack in one
 * process would make that false for a real node. Readers go by type and subtype
 * (`isVault`, `isVaultScope`).
 */
import { MetaData } from "@metaobjectsdev/metadata";
import { SCOPE_SUBTYPE_ENV, TYPE_SCOPE, TYPE_VAULT } from "./constants.js";

/** A secret store: `vault.<product>`. */
export class MetaVault extends MetaData {}

/** One environment's place in a vault: `scope.env`. */
export class MetaVaultScope extends MetaData {}

export function isVault(node: MetaData): boolean {
  return node.typeId.type === TYPE_VAULT;
}

export function isVaultScope(node: MetaData): boolean {
  return node.typeId.type === TYPE_SCOPE && node.typeId.subType === SCOPE_SUBTYPE_ENV;
}
