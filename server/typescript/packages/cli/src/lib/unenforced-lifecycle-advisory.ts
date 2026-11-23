// A lifecycle no generated code enforces (ADR-0067 §6).
//
// An enum with a transition is a lifecycle: the model says a row moves from state to state
// only by its transitions, and a command per transition asks the policy first (ADR-0066). The
// layer that enforces that is the service (`serviceFile()`, stable name `service`). The flat
// routes generators write no rules at all, by decision: a project that asked for nothing sees
// no change in their output. So a project that declares a lifecycle and wires no service
// generator for that entity has rules nothing checks: an update can set the state field to any
// member, and no permission is asked.
//
// Advisory, never a gate: the project may enforce the lifecycle in code of its own, or not
// serve the entity at all. This names each such entity and the generator that would enforce it.
// It reads the project's `generators` list, so it is TypeScript's own: each port's list lives in
// its own build configuration (ADR-0067 §5).

import type { MetaData } from "@metaobjectsdev/metadata";
import { commandEntities, lifecyclesOf } from "@metaobjectsdev/metadata";

/** The stable name of the generator that enforces a lifecycle (and of its ejected copy). */
export const SERVICE_GENERATOR_NAME = "service";

/** One `generators` entry as the config declares it: a stable name, or a generator object. */
export type GeneratorEntry = string | { name: string; filter?: (entity: MetaData) => boolean };

export interface UnenforcedLifecycleFinding {
  /** The metadata file declaring the entity ("" when the loader recorded none). */
  file: string;
  /** The entity's FQN. */
  construct: string;
  message: string;
}

export interface UnenforcedLifecycleOptions {
  /** Skip an entity by FQN: imported (dependency) metadata is not the adopter's to fix. */
  skip?: (fqn: string) => boolean;
}

/** True when some entry is the service generator and its own filter keeps `entity`. */
function serviceCovers(generators: readonly GeneratorEntry[], entity: MetaData): boolean {
  return generators.some((g) =>
    typeof g === "string"
      ? g === SERVICE_GENERATOR_NAME
      : g.name === SERVICE_GENERATOR_NAME && (g.filter?.(entity) ?? true),
  );
}

/**
 * Every concrete entity with a source and a lifecycle that no listed service generator covers.
 * An entity with no source is inert (it derives no command), so it is not named.
 */
export function scanForUnenforcedLifecycles(
  root: MetaData,
  generators: readonly GeneratorEntry[],
  opts: UnenforcedLifecycleOptions = {},
): UnenforcedLifecycleFinding[] {
  const out: UnenforcedLifecycleFinding[] = [];
  for (const entity of commandEntities(root)) {
    const lifecycles = lifecyclesOf(entity);
    if (lifecycles.length === 0) continue;
    const fqn = entity.resolutionKey();
    if (opts.skip?.(fqn) === true) continue;
    const files = "files" in entity.source ? entity.source.files : [];
    // A node a shipped library contributed is the library's design, not the adopter's.
    if (files.some((f) => f.startsWith("library:"))) continue;
    if (serviceCovers(generators, entity)) continue;
    const fields = lifecycles.map((l) => `"${l.field.name}"`).join(", ");
    out.push({
      file: files[0] ?? "",
      construct: fqn,
      message:
        `${fqn} declares a lifecycle on ${fields}, and no service generator covers it, so nothing ` +
        `generated enforces its transitions or asks its permissions: the flat routes write the field ` +
        `like any other. Add serviceFile() (stable name "service") with contractTypes() and a ` +
        `transport (serviceRoutesFile() or serviceRoutesHonoFile()) to \`generators\`, or enforce ` +
        `the lifecycle in code of your own and ignore this.`,
    });
  }
  return out;
}
