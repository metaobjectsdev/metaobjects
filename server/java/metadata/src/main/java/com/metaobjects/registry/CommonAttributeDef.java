// Copyright 2026 MetaObjects authors.
package com.metaobjects.registry;

/**
 * Definition of a "common attribute" — one that is valid on any metadata node
 * (every type / every subType). Used by the cross-language commonAttrs
 * contract (documentation provider in TS / C# / Python / Java).
 *
 * @param name      bare attribute name (no {@code @} prefix; e.g. {@code "description"})
 * @param valueType attribute value subtype (e.g. {@code StringAttribute.SUBTYPE_STRING},
 *                  {@code BooleanAttribute.SUBTYPE_BOOLEAN})
 * @param isArray   {@code true} if the attribute holds an array of {@code valueType}
 *                  (e.g. {@code aliases}, {@code seeAlso}, {@code replacedBy})
 */
public record CommonAttributeDef(String name, String valueType, boolean isArray) {
}
