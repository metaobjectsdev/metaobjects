// MetaOrigin — concrete node class for type=origin nodes.
// Field-level provenance (Project E).
// passthrough / aggregate origin subtypes declare how field values are derived.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";

export class MetaOrigin extends MetaData {}
