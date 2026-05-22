// MetaView — concrete node class for type=view nodes.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.
// Currently minimal — placeholder for v0.3+ view-level accessors.

import { MetaData } from "../../shared/meta-data.js";

export class MetaView extends MetaData {}
