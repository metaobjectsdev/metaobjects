// An app's delivery facts as plain records: its build and its processes, the same in every
// environment. A platform pack's generator reads them through here rather than decoding the
// attributes itself, so a new build.* or runtime.process attribute is read in one place.
// Accessors are the resolving ones (ADR-0039): a build or process an app inherits through
// `extends` counts.

import type { MetaData } from "@metaobjectsdev/metadata";
import { refList } from "@metaobjectsdev/pack-systems";
import {
  BUILD_ATTR_COMMAND,
  BUILD_ATTR_CONTEXT,
  BUILD_ATTR_DIRECTORY,
  BUILD_ATTR_PATH,
  BUILD_ATTR_WATCH_EXCLUDE,
  BUILD_ATTR_WATCH_INCLUDE,
  RUNTIME_ATTR_COMMAND,
  RUNTIME_ATTR_DRAIN_SECONDS,
  RUNTIME_ATTR_HEALTH_PATH,
  RUNTIME_ATTR_HEALTH_TIMEOUT_SECONDS,
  RUNTIME_ATTR_PORT,
  RUNTIME_ATTR_RESTART,
  TYPE_BUILD,
  TYPE_RUNTIME,
} from "./constants.js";

export interface Build {
  /** The build subtype: dockerfile, command or static. */
  readonly kind: string;
  readonly watchInclude: readonly string[];
  readonly watchExclude: readonly string[];
  readonly path?: string;
  readonly context?: string;
  readonly command?: string;
  readonly directory?: string;
}

export interface Process {
  readonly name: string;
  readonly command?: string;
  readonly port?: number;
  readonly healthPath?: string;
  readonly healthTimeoutSeconds?: number;
  readonly drainSeconds?: number;
  /** always, onFailure or never. */
  readonly restart?: string;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

/** `T` with each field that may be undefined made optional instead. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** The fields of `values` that are set: an absent fact stays absent, not `undefined`. */
function defined<T extends object>(values: T): Defined<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** The app's build, or undefined when it declares none. */
export function readBuild(app: MetaData): Build | undefined {
  // ADR-0039: resolving, so a build the app inherits through `extends` counts.
  const b = app.children().find((c) => c.type === TYPE_BUILD);
  if (b === undefined) return undefined;
  return defined({
    kind: b.subType,
    watchInclude: refList(b, BUILD_ATTR_WATCH_INCLUDE),
    watchExclude: refList(b, BUILD_ATTR_WATCH_EXCLUDE),
    path: text(b.attr(BUILD_ATTR_PATH)),
    context: text(b.attr(BUILD_ATTR_CONTEXT)),
    command: text(b.attr(BUILD_ATTR_COMMAND)),
    directory: text(b.attr(BUILD_ATTR_DIRECTORY)),
  });
}

/** The app's processes, in model order. */
export function readProcesses(app: MetaData): Process[] {
  // ADR-0039: resolving, as for the build.
  return app
    .children()
    .filter((c) => c.type === TYPE_RUNTIME)
    .map((p) =>
      defined({
        name: p.name,
        command: text(p.attr(RUNTIME_ATTR_COMMAND)),
        port: int(p.attr(RUNTIME_ATTR_PORT)),
        healthPath: text(p.attr(RUNTIME_ATTR_HEALTH_PATH)),
        healthTimeoutSeconds: int(p.attr(RUNTIME_ATTR_HEALTH_TIMEOUT_SECONDS)),
        drainSeconds: int(p.attr(RUNTIME_ATTR_DRAIN_SECONDS)),
        restart: text(p.attr(RUNTIME_ATTR_RESTART)),
      }),
    );
}
