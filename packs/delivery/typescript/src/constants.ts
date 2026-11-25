// The delivery pack's vocabulary names, one constant each (metamodel/delivery.json is the
// definition; these are the spellings code compares against).

export const DELIVERY_PROVIDER_ID = "metaobjects-delivery";

export const TYPE_ENVIRONMENT = "environment";
export const ENVIRONMENT_SUBTYPE_STANDING = "standing";
export const ENVIRONMENT_SUBTYPE_EPHEMERAL = "ephemeral";
export const ENVIRONMENT_SUBTYPE_LOCAL = "local";

export const TYPE_BUILD = "build";
export const BUILD_SUBTYPE_DOCKERFILE = "dockerfile";
export const BUILD_SUBTYPE_COMMAND = "command";
export const BUILD_SUBTYPE_STATIC = "static";

export const TYPE_RUNTIME = "runtime";
export const RUNTIME_SUBTYPE_PROCESS = "process";

/** A platform pack registers the concrete `deployment.<platform>` subtype. */
export const TYPE_DEPLOYMENT = "deployment";
export const DEPLOYMENT_ATTR_APP = "app";
export const DEPLOYMENT_ATTR_ENVIRONMENT = "environment";
export const DEPLOYMENT_ATTR_DOMAINS = "domains";
export const DEPLOYMENT_ATTR_REPLICAS = "replicas";
export const DEPLOYMENT_ATTR_REGION = "region";
export const DEPLOYMENT_ATTR_BRANCH = "branch";
export const DEPLOYMENT_ATTR_SECRETS = "secrets";

export const TYPE_VALUE = "value";
export const VALUE_SUBTYPE_LITERAL = "literal";
export const VALUE_SUBTYPE_REF = "ref";
export const VALUE_ATTR_SETTING = "setting";
export const VALUE_ATTR_LITERAL = "literal";
export const VALUE_ATTR_FROM = "from";
export const VALUE_ATTR_OUTPUT = "output";

/** Raised when a deployment's @app / @environment or a value.ref's @from names nothing, or the wrong kind of node. */
export const ERR_DELIVERY_UNRESOLVED_REF = "ERR_DELIVERY_UNRESOLVED_REF";
