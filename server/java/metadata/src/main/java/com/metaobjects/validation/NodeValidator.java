package com.metaobjects.validation;

import com.metaobjects.MetaData;

/**
 * An imperative validator for a node of a given (type, subType), registered with the type
 * by its provider. In Java/C# this is typically a METHOD REFERENCE (the logic lives on/by
 * the typed node class and uses its typed accessors); dispatch is via the registry, so a
 * downstream provider's validator runs without core changes.
 *
 * <p>INTENTIONALLY UNUSED BY CORE — do not remove as "dead code". This is an EXTENSION
 * POINT (a downstream provider registers a new type WITH its own validator + error codes —
 * the ADR-0023 thesis) and the documented escape hatch in the config-driven-validation
 * design (issue #51) for novel cross-field rules that fit no declarative shape. Core's own
 * per-type validation lives in reference descriptors (live) + declarative rule-shapes
 * (#51, planned), NOT in this imperative per-node hook.</p>
 */
@FunctionalInterface
public interface NodeValidator {
    void validate(MetaData node, ValidationContext ctx);
}
