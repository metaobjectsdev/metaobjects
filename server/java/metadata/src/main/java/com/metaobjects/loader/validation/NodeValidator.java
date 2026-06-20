package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;

/**
 * An imperative validator for a node of a given (type, subType), registered with the type
 * by its provider. In Java/C# this is typically a METHOD REFERENCE (the logic lives on/by
 * the typed node class and uses its typed accessors); dispatch is via the registry, so a
 * downstream provider's validator runs without core changes.
 */
@FunctionalInterface
public interface NodeValidator {
    void validate(MetaData node, ValidationContext ctx);
}
