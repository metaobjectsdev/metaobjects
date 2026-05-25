package com.metaobjects.metadata.ktx

import com.metaobjects.MetaData
import com.metaobjects.attr.MetaAttribute

/**
 * Own-only attribute helpers — read attributes declared directly on a node,
 * ignoring anything inherited from a super. Mirrors [MetaData.hasMetaAttr] +
 * [MetaData.getMetaAttr] with the `includeParentData=false` flag pinned.
 */

/** Read an own-only attribute as [MetaAttribute]; null if absent. */
fun MetaData.attrOrNull(name: String): MetaAttribute<*>? =
    if (hasMetaAttr(name, false)) getMetaAttr(name, false) else null

/** Read an own-only attribute's string form (via `DataConverter`); null if absent. */
fun MetaData.attrStringOrNull(name: String): String? =
    attrOrNull(name)?.valueAsString
