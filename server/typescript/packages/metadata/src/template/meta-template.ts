import { MetaData } from "../shared/meta-data.js";

/**
 * `template.*` node — the fourth-pillar metatype (FR-004, R1).
 *
 * A single class backs every subtype (`template.base/prompt/output/toolcall`),
 * mirroring `MetaSource`: the loader dispatches by subtype and per-subtype
 * attribute schemas (FR-033: externalized to spec/metamodel/template.json,
 * embedded at build into TEMPLATE_DEFINITION) drive validation. Typed accessors
 * are deferred to the render-engine / verify work — attr values read generically
 * via `ownAttr(...)` until then, so no untested forward-looking surface ships.
 */
export class MetaTemplate extends MetaData {}
