// The systems pack's vocabulary names, one constant each (metamodel/systems.json is the
// definition; these are the spellings code compares against).

export const SYSTEMS_PROVIDER_ID = "metaobjects-systems";

export const TYPE_SYSTEM = "system";
export const SYSTEM_SUBTYPE_INTERNAL = "internal";
export const SYSTEM_SUBTYPE_EXTERNAL = "external";

export const TYPE_APP = "app";
export const APP_SUBTYPE_SERVICE = "service";
export const APP_SUBTYPE_CLIENT = "client";
export const APP_SUBTYPE_JOB = "job";

export const TYPE_RESOURCE = "resource";

export const APP_ATTR_NEEDS = "needs";
export const APP_ATTR_CALLS = "calls";
export const APP_ATTR_SETTINGS = "settings";
export const APP_ATTR_SHELL = "shell";
export const APP_ATTR_SCHEDULE = "schedule";

export const RESOURCE_ATTR_ENGINE = "engine";
export const RESOURCE_ATTR_VERSION = "version";
export const RESOURCE_ATTR_MANAGED_BY = "managedBy";

/** Raised when an app's @needs or @calls names nothing, or the wrong kind of node. */
export const ERR_SYSTEMS_UNRESOLVED_REF = "ERR_SYSTEMS_UNRESOLVED_REF";
