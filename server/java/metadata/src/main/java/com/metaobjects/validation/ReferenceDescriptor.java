package com.metaobjects.validation;

/**
 * Declares that an attribute on a node is a cross-reference to another node — the
 * data-driven half of the validation model. A generic resolver reads these and enforces
 * them against the symbol table, so {@code @objectRef}/{@code @references}/future kinds are
 * validated uniformly, and a downstream provider's reference attr is covered for free.
 *
 * @param attr            the attr carrying the reference value (e.g. "objectRef")
 * @param targetType      required resolved-node type (e.g. "object")
 * @param targetSubType   required resolved-node subType, or {@code null} for any
 * @param dottedFieldPath when true, resolve the entity segment before the first "."
 *                        (packages use "::", never ".", so "Entity.field" → "Entity")
 * @param errorCode       code emitted on unresolved / kind-mismatch (may be a downstream code)
 */
public record ReferenceDescriptor(String attr, String targetType, String targetSubType,
                                  boolean dottedFieldPath, String errorCode) {}
