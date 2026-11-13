// MetaTransition — node class for `transition.*` (ADR-0063). Accessors are
// RESOLVING (ADR-0039): a transition declared on a base entity's field applies,
// unchanged, to every entity that extends it.

import { MetaData } from "../../shared/meta-data.js";
import {
  TRANSITION_ATTR_CONDITION,
  TRANSITION_ATTR_FROM,
  TRANSITION_ATTR_PERMISSION,
  TRANSITION_ATTR_PUBLIC,
  TRANSITION_ATTR_TO,
} from "./transition-constants.js";

export class MetaTransition extends MetaData {
  /** The states this move may start from. A bare string is one element. */
  from(): readonly string[] {
    const v = this.attr(TRANSITION_ATTR_FROM);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return typeof v === "string" ? [v] : [];
  }
  to(): string | undefined {
    const v = this.attr(TRANSITION_ATTR_TO);
    return typeof v === "string" ? v : undefined;
  }
  condition(): unknown {
    return this.attr(TRANSITION_ATTR_CONDITION);
  }
  permission(): string | undefined {
    const v = this.attr(TRANSITION_ATTR_PERMISSION);
    return typeof v === "string" ? v : undefined;
  }
  isPublic(): boolean {
    return this.attr(TRANSITION_ATTR_PUBLIC) === true;
  }
}
