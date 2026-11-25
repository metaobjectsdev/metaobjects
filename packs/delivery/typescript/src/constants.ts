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
export const BUILD_ATTR_WATCH_INCLUDE = "watchInclude";
export const BUILD_ATTR_WATCH_EXCLUDE = "watchExclude";
export const BUILD_ATTR_PATH = "path";
export const BUILD_ATTR_CONTEXT = "context";
export const BUILD_ATTR_COMMAND = "command";
export const BUILD_ATTR_DIRECTORY = "directory";

export const TYPE_RUNTIME = "runtime";
export const RUNTIME_SUBTYPE_PROCESS = "process";
export const RUNTIME_ATTR_COMMAND = "command";
export const RUNTIME_ATTR_PORT = "port";
export const RUNTIME_ATTR_HEALTH_PATH = "healthPath";
export const RUNTIME_ATTR_HEALTH_TIMEOUT_SECONDS = "healthTimeoutSeconds";
export const RUNTIME_ATTR_DRAIN_SECONDS = "drainSeconds";
export const RUNTIME_ATTR_RESTART = "restart";
export const RESTART_ALWAYS = "always";
export const RESTART_ON_FAILURE = "onFailure";
export const RESTART_NEVER = "never";

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
export const VALUE_ATTR_PRODUCED_BY = "producedBy";
export const VALUE_ATTR_OUTPUT = "output";
export const VALUE_ATTR_PATH = "path";
export const VALUE_OUTPUTS = ["url", "host", "port", "user", "password", "privateUrl", "publicUrl"] as const;
export type ValueOutput = (typeof VALUE_OUTPUTS)[number];
export const OUTPUT_URL = "url";
export const OUTPUT_HOST = "host";
export const OUTPUT_PORT = "port";
export const OUTPUT_PRIVATE_URL = "privateUrl";
export const OUTPUT_PUBLIC_URL = "publicUrl";

/** Raised when a deployment's @app / @environment or a value.ref's @producedBy names nothing, or the wrong kind of node. */
export const ERR_DELIVERY_UNRESOLVED_REF = "ERR_DELIVERY_UNRESOLVED_REF";

/** Raised when a deployment holds two values for one @setting. */
export const ERR_DELIVERY_DUPLICATE_SETTING = "ERR_DELIVERY_DUPLICATE_SETTING";

/** Raised when two deployments target the same (@app, @environment). */
export const ERR_DELIVERY_DUPLICATE_DEPLOYMENT = "ERR_DELIVERY_DUPLICATE_DEPLOYMENT";

/** Raised when a value.ref asks its producer for an output it does not have: `@path` on an output that is not a URL, or an app asked for its url, user or password, or for its port with none declared. */
export const ERR_DELIVERY_UNSUPPORTED_OUTPUT = "ERR_DELIVERY_UNSUPPORTED_OUTPUT";

/** The outputs that are URLs, the only ones a value.ref `@path` may extend. */
export const URL_OUTPUTS: readonly ValueOutput[] = [OUTPUT_URL, OUTPUT_PRIVATE_URL, OUTPUT_PUBLIC_URL];
/** The outputs an app produces: its addresses. A resource produces every output its engine has. */
export const APP_OUTPUTS: readonly ValueOutput[] = [OUTPUT_HOST, OUTPUT_PORT, OUTPUT_PRIVATE_URL, OUTPUT_PUBLIC_URL];
/** The app outputs that need a runtime.process `@port`. */
export const PORT_OUTPUTS: readonly ValueOutput[] = [OUTPUT_PORT, OUTPUT_PRIVATE_URL];
