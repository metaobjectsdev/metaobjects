// View attribute schemas — per-subtype attr inventories for view types.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../../core/attr/attr-constants.js";
import {
  VIEW_CURRENCY_ATTR_LOCALE,
  VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
} from "./view-constants.js";

/** Attrs on view.currency. */
export const currencyViewAttrs: AttrSchema[] = [
  {
    name: VIEW_CURRENCY_ATTR_LOCALE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    default: VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
    description:
      "BCP 47 locale code controlling currency display formatting. Defaults to 'en-US' when omitted.",
  },
];
