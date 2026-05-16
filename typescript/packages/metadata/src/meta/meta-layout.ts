// MetaLayout — concrete node class for type=layout nodes.
// Object-level UI surfaces (Project E; replaces object-attached data-grid view
// subtype; views are strictly field-level per Java parity).
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";

export class MetaLayout extends MetaData {}
