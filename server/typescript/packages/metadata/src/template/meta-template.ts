import { MetaData } from "../shared/meta-data.js";

/**
 * `template.*` node — the fourth-pillar metatype (FR-004, R1).
 *
 * A single class backs both subtypes (`template.prompt`, `template.output`),
 * mirroring `MetaSource`: the loader dispatches by subtype and per-subtype
 * attribute schemas (see `template-schema.ts`) drive validation. Typed accessors
 * are deferred to the render-engine / verify work — attr values read generically
 * via `ownAttr(...)` until then, so no untested forward-looking surface ships.
 */
export class MetaTemplate extends MetaData {}
