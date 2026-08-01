/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
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
     * FR-032 (ADR-0032): a ref-bearing attribute in canonical JSON carries a
     * relative reference form (value starting with {@code ::} or {@code ..::}).
     * Canonical JSON must be fully qualified — relative forms are YAML-authoring
     * sugar that the desugar expands before lowering to canonical JSON.
     * Cross-language contract: {@code ERR_RELATIVE_REF_IN_CANONICAL}.
     */
    public static final String ERR_RELATIVE_REF_IN_CANONICAL = "ERR_RELATIVE_REF_IN_CANONICAL";

    /**
     * Error code emitted when a field origin (passthrough / aggregate / collection)
     * declares an invalid path or attribute (e.g. malformed {@code @via} relationship
     * path, missing required attribute for the subtype).
     * Cross-language contract: {@code ERR_INVALID_ORIGIN}.
     */
    public static final String ERR_INVALID_ORIGIN = "ERR_INVALID_ORIGIN";

    /**
     * FR-017: a M:N relationship's slim vocabulary is invalid — {@code @through} does not
     * name a junction declaring two {@code identity.reference} children, {@code @sourceRefField}
     * does not match one of them, or a M:N-only attr ({@code @through}/{@code @sourceRefField}/
     * {@code @symmetric}) is set on a non-M:N (1:N / {@code @cardinality:one}) relationship.
     * Cross-language contract: {@code ERR_INVALID_RELATIONSHIP}.
     */
    public static final String ERR_INVALID_RELATIONSHIP = "ERR_INVALID_RELATIONSHIP";

    /**
     * Error code emitted when an {@code identity.reference} {@code @references} names an
     * FK target object that does not resolve to any object in the loaded tree.
     * Cross-language contract: {@code ERR_INVALID_REFERENCE}.
     */
    public static final String ERR_INVALID_REFERENCE = "ERR_INVALID_REFERENCE";

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

    /**
     * Error code emitted when a parent declares more than the registered
     * {@code maxOccurs} children of a singleton {@code type.subType}
     * (e.g. two {@code identity.primary} under one object).
     * Cross-language contract: {@code ERR_TOO_MANY_OCCURRENCES}.
     */
    public static final String ERR_TOO_MANY_OCCURRENCES = "ERR_TOO_MANY_OCCURRENCES";

    /**
     * FR-016 / ADR-0018: a {@code source.rdb} declares a kind-aware physical-name
     * alias ({@code @view} / {@code @materializedView} / {@code @proc} /
     * {@code @function}) that does not match its {@code @kind}. The legacy
     * {@code @table}-for-non-table case warns rather than errors.
     * Cross-language contract: {@code ERR_PHYSICAL_NAME_KIND_MISMATCH}.
     */
    public static final String ERR_PHYSICAL_NAME_KIND_MISMATCH = "ERR_PHYSICAL_NAME_KIND_MISMATCH";

    /**
     * FR-016 / ADR-0018: a {@code source.rdb} declares two or more kind-aware
     * physical-name aliases at once (e.g. both {@code @table} and {@code @view}).
     * Exactly one is permitted.
     * Cross-language contract: {@code ERR_PHYSICAL_NAME_MULTIPLE}.
     */
    public static final String ERR_PHYSICAL_NAME_MULTIPLE = "ERR_PHYSICAL_NAME_MULTIPLE";

    /**
     * FR-016 / ADR-0018 warning: a {@code source.rdb} uses the pre-1.0 legacy
     * {@code @table} spelling with a non-table {@code @kind}. The loader accepts
     * the value but warns; the canonical serializer rewrites it to the
     * kind-matching alias on round-trip.
     * Cross-language contract: {@code WARN_LEGACY_PHYSICAL_NAME_ALIAS}.
     */
    public static final String WARN_LEGACY_PHYSICAL_NAME_ALIAS = "WARN_LEGACY_PHYSICAL_NAME_ALIAS";

    /**
     * FR-013 warning: {@code @readOnly: true} on a field child of an
     * {@code object.value}. Value-objects have no persistence semantics, so the
     * read-only contract is advisory (codegen may use it for record/struct
     * treatment). Cross-language contract: {@code WARN_READONLY_VALUE_OBJECT}.
     */
    public static final String WARN_READONLY_VALUE_OBJECT = "WARN_READONLY_VALUE_OBJECT";

    /**
     * Error code emitted when the YAML metadata input is not valid YAML, or cannot be
     * desugared into canonical metadata (ADR-0006).
     * Cross-language contract: {@code ERR_MALFORMED_YAML}.
     */
    public static final String ERR_MALFORMED_YAML = "ERR_MALFORMED_YAML";

    /**
     * Error code emitted when a YAML 1.2 silent type coercion changed an authored value's
     * runtime type away from the attribute's declared valueType (e.g. unquoted
     * {@code column: TRUE} parsed as boolean for a string-typed attr) (ADR-0006 D2).
     * Cross-language contract: {@code ERR_YAML_COERCION}.
     */
    public static final String ERR_YAML_COERCION = "ERR_YAML_COERCION";

    /**
     * Error code emitted when {@code field.object @storage="flattened"} is combined
     * with {@code isArray=true} (flattened materialises one-column-per-field; arrays
     * require {@code @storage="jsonb"}).
     * Cross-language contract: {@code ERR_STORAGE_FLATTENED_ARRAY}.
     */
    public static final String ERR_STORAGE_FLATTENED_ARRAY = "ERR_STORAGE_FLATTENED_ARRAY";

    /**
     * Error code emitted when {@code field.object @storage} is set on a field that
     * has no {@code @objectRef} — storage shape only applies to referenced objects.
     * Cross-language contract: {@code ERR_STORAGE_WITHOUT_OBJECT_REF}.
     */
    public static final String ERR_STORAGE_WITHOUT_OBJECT_REF = "ERR_STORAGE_WITHOUT_OBJECT_REF";

    /**
     * Error code emitted when a {@code field.object} declares no {@code @objectRef}
     * (ADR-0013). A field.object models a typed nested value and REQUIRES @objectRef;
     * an open/untyped JSON map uses the physical {@code @dbColumnType: jsonb} escape
     * hatch on a {@code field.string} instead of a bare object.
     * Cross-language contract: {@code ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF}.
     */
    public static final String ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF = "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF";

    /**
     * Error code emitted when a {@code layout.dataGrid @filter} clause references
     * a field that is not declared filterable, or applies an operator the field's
     * subtype does not support.
     * Cross-language contract: {@code ERR_BAD_ATTR_FILTER}.
     */
    public static final String ERR_BAD_ATTR_FILTER = "ERR_BAD_ATTR_FILTER";

    /**
     * SP-H Unit9 — a field carries {@code @filterable: true} but its subtype has
     * no filter-operator band (e.g. {@code field.object}). Generating a filter
     * for it would emit an empty operator set — a route that rejects every request.
     * Cross-language contract: {@code ERR_FILTERABLE_UNSUPPORTED_SUBTYPE}.
     */
    public static final String ERR_FILTERABLE_UNSUPPORTED_SUBTYPE = "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE";

    /**
     * Error code emitted when a {@code layout.dataGrid @defaultSortField} value
     * does not name a real field on the owning entity.
     * Cross-language contract: {@code ERR_BAD_DEFAULT_SORT_FIELD}.
     */
    public static final String ERR_BAD_DEFAULT_SORT_FIELD = "ERR_BAD_DEFAULT_SORT_FIELD";

    /**
     * Error code emitted when a {@code template.*} node fails structural
     * validation: unresolved {@code @payloadRef}, {@code @requiredSlots}
     * referring to non-existent payload fields, etc.
     * Cross-language contract: {@code ERR_INVALID_TEMPLATE}.
     */
    public static final String ERR_INVALID_TEMPLATE = "ERR_INVALID_TEMPLATE";

    /**
     * Error code emitted when an {@code index.lookup}'s {@code @fields} is empty
     * (at least one field is required) or names a field that does not exist on the
     * owning entity's effective (resolved, via {@code extends:}) field set.
     * Cross-language contract: {@code ERR_INVALID_INDEX}.
     */
    public static final String ERR_INVALID_INDEX = "ERR_INVALID_INDEX";

    /**
     * #208 (DDL-ownership escape valves, design doc §5 R1): a {@code source.rdb}
     * declares both {@code @sql} and {@code @unmanaged} on the same source.
     * Cross-language contract: {@code ERR_SQL_BODY_WITH_UNMANAGED}.
     */
    public static final String ERR_SQL_BODY_WITH_UNMANAGED = "ERR_SQL_BODY_WITH_UNMANAGED";

    /**
     * #208 (design doc §5 R2): a {@code source.rdb} declares {@code @sql} with a
     * writable {@code @kind} ("table", the default) — {@code @sql} is legal only
     * on a read-only kind.
     * Cross-language contract: {@code ERR_SQL_BODY_ON_WRITABLE_KIND}.
     */
    public static final String ERR_SQL_BODY_ON_WRITABLE_KIND = "ERR_SQL_BODY_ON_WRITABLE_KIND";

    /**
     * #208 (design doc §5 R4/R5): an {@code origin.*}-bearing (derived) own field,
     * or an {@code object.projection}'s row-scope {@code @filter} (#207), lives
     * under a host object that declares an {@code @sql} read source.
     * Cross-language contract: {@code ERR_ORIGIN_UNDER_SQL_BODY}.
     */
    public static final String ERR_ORIGIN_UNDER_SQL_BODY = "ERR_ORIGIN_UNDER_SQL_BODY";

    /**
     * #246: a {@code field.enum} both extends a shared package-level abstract
     * enum and declares its own {@code @values}. One shared enum type has one
     * member set — the own {@code @values} would be silently dropped in
     * codegen.
     * Cross-language contract: {@code ERR_ENUM_EXTENDS_VALUES_CONFLICT}.
     */
    public static final String ERR_ENUM_EXTENDS_VALUES_CONFLICT = "ERR_ENUM_EXTENDS_VALUES_CONFLICT";

    /**
     * #208 (design doc §5 R6) warning: an {@code origin.*}-bearing (derived) own
     * field lives under a host object that declares an {@code @unmanaged} source.
     * {@code @unmanaged} acts on nothing, so documented-but-unacted-on lineage is
     * benign — informational only, never an error.
     * Cross-language contract: {@code WARN_ORIGIN_UNDER_UNMANAGED}.
     */
    public static final String WARN_ORIGIN_UNDER_UNMANAGED = "WARN_ORIGIN_UNDER_UNMANAGED";

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