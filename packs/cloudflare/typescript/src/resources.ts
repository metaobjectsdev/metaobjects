/**
 * The one place the pack reads the systems pack's resource.* nodes: which Cloudflare binding
 * places which kind of resource, and whether a resource lives outside the platform. Every
 * other module asks these functions, so a change to how resources are described is a change
 * here only.
 */
import type { MetaData } from "@metaobjectsdev/metadata";
import { RESOURCE_ATTR_ENGINE, RESOURCE_ATTR_MANAGED_BY } from "@metaobjectsdev/pack-systems";
import { BINDING_D1, BINDING_KV, BINDING_QUEUE, BINDING_R2 } from "./constants.js";

/** The resource.* subtype each binding places. A rate limiter places none. */
const BINDING_RESOURCE: Readonly<Record<string, string>> = {
  [BINDING_D1]: "database",
  [BINDING_KV]: "keyvalue",
  [BINDING_R2]: "bucket",
  [BINDING_QUEUE]: "queue",
};

/** `resource.* @managedBy` value for a resource that lives outside the platform. */
const MANAGED_BY_EXTERNAL = "external";

/** The resource kind a binding subtype places, or undefined for a binding that places none. */
export function resourceKindOf(bindingKind: string): string | undefined {
  return BINDING_RESOURCE[bindingKind];
}

/** The binding subtype that places `resource` on Cloudflare, or undefined when none can. */
export function bindingKindFor(resource: MetaData): string | undefined {
  return Object.entries(BINDING_RESOURCE).find(([, sub]) => sub === resource.subType)?.[0];
}

/** Whether `resource` lives outside the platform and so is reached through settings, never bound. */
export function isExternal(resource: MetaData): boolean {
  return resource.attr(RESOURCE_ATTR_MANAGED_BY) === MANAGED_BY_EXTERNAL;
}

/** `resource.database \`db\` (postgres)`, for the unexpressed-facts file. */
export function describeResource(resource: MetaData): string {
  const engine = resource.attr(RESOURCE_ATTR_ENGINE);
  return `resource.${resource.subType} \`${resource.name}\`${typeof engine === "string" && engine !== "" ? ` (${engine})` : ""}`;
}

/** The binding kinds that place a resource, for messages. */
export function bindableKinds(): string {
  return Object.entries(BINDING_RESOURCE).map(([b, r]) => `${r} on ${b}`).join(", ");
}
