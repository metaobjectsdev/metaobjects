import { MetaData } from "../shared/meta-data.js";

/**
 * `prompt.*` node — the fourth-pillar metatype (FR-004).
 *
 * A single class backs all prompt subtypes (mirrors `MetaSource`): the loader
 * dispatches `prompt.template` / `prompt.fragment` to this class, and per-subtype
 * attribute schemas (see `prompt-schema.ts`) drive validation. Typed accessors
 * (payloadRef, textRef, …) are deferred to the render-engine plan (Plan #2),
 * where they are exercised — until then, attr values are read generically via
 * `ownAttr(...)`, so no untested forward-looking surface ships here.
 */
export class MetaPrompt extends MetaData {}
