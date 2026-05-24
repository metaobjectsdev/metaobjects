/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */

package com.metaobjects.util;

/**
 * Error message format templates for consistent error reporting across the MetaObjects framework.
 *
 * <p>These format templates provide standardized patterns for common error scenarios,
 * ensuring consistent messaging and easier localization support in the future.</p>
 *
 * @since 6.0.0
 */
public final class ErrorMessageConstants {

    private ErrorMessageConstants() {
        // Utility class - no instantiation
    }

    // === CROSS-LANGUAGE ERROR CODES ===
    // These codes are part of the shared conformance contract across all language ports
    // (TypeScript, Java, Python, C#). Keep them identical to the TS/C# constants.

    /**
     * Error code emitted when a required attribute is absent.
     * Cross-language contract: {@code ERR_MISSING_REQUIRED_ATTR}.
     */
    public static final String ERR_MISSING_REQUIRED_ATTR = "ERR_MISSING_REQUIRED_ATTR";

    /**
     * Error code emitted when an attribute value fails content validation
     * (e.g. an enum {@code @values} member is not an identifier-safe symbol, is empty, or
     * contains a duplicate).
     * Cross-language contract: {@code ERR_BAD_ATTR_VALUE}.
     */
    public static final String ERR_BAD_ATTR_VALUE = "ERR_BAD_ATTR_VALUE";

    /**
     * Error code emitted when a reserved structural keyword ({@code name}, {@code package},
     * {@code extends}, {@code abstract}, {@code overlay}, {@code isArray}, {@code children},
     * {@code value}) is written as an {@code @}-prefixed attribute in canonical JSON.
     * Cross-language contract: {@code ERR_RESERVED_ATTR}.
     */
    public static final String ERR_RESERVED_ATTR = "ERR_RESERVED_ATTR";

    /**
     * Error code emitted when an object declares one or more sources but none has
     * role {@code "primary"}.
     * Cross-language contract: {@code ERR_SOURCE_NO_PRIMARY}.
     */
    public static final String ERR_SOURCE_NO_PRIMARY = "ERR_SOURCE_NO_PRIMARY";

    /**
     * Error code emitted when an object declares more than one source with
     * role {@code "primary"}.
     * Cross-language contract: {@code ERR_SOURCE_MULTIPLE_PRIMARY}.
     */
    public static final String ERR_SOURCE_MULTIPLE_PRIMARY = "ERR_SOURCE_MULTIPLE_PRIMARY";

    // === ERROR MESSAGE FORMATS ===

    /** Format template for not found errors */
    public static final String ERR_NOT_FOUND_FORMAT = "%s '%s' not found in %s";

    /** Format template for type mismatch errors */
    public static final String ERR_TYPE_MISMATCH_FORMAT = "Type mismatch at %s: Expected %s, got %s";

    /** Format template for validation errors */
    public static final String ERR_VALIDATION_FORMAT = "Validation failed for %s: %s";

    /** Format template for configuration errors */
    public static final String ERR_CONFIG_FORMAT = "Configuration error in %s: %s";
}