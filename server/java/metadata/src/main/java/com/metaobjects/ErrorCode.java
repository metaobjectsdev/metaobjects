/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects;

/**
 * Stable, language-neutral error codes — mirrors
 * {@code fixtures/conformance/ERROR-CODES.json} and the C# {@code ErrorCode} enum.
 *
 * <p>This is a <strong>closed</strong> set. Every member corresponds to an entry in
 * the shared conformance error-code registry. When a new code is added to
 * {@code ERROR-CODES.json} it must also be added here (and to the parallel C# and
 * TypeScript constants).</p>
 *
 * <p>Only the enum-validation path adopts coded exceptions in this phase. Other
 * call sites continue to throw {@link MetaDataException} with message-embedded codes
 * until they are migrated; the {@code ErrorCode} field on those exceptions remains
 * {@code null}.</p>
 *
 * @since 6.1.0
 */
public enum ErrorCode {

    /** The input is not valid JSON (parse failure before structural checks). */
    ERR_MALFORMED_JSON,

    /** The metadata document root is not a JSON object. */
    ERR_TOP_LEVEL_NOT_OBJECT,

    /** A node uses a type not registered in the registry. */
    ERR_UNKNOWN_TYPE,

    /** A node uses a subType not valid for its type. */
    ERR_UNKNOWN_SUBTYPE,

    /** A node omits subType and the type has no default subType. */
    ERR_MISSING_SUBTYPE,

    /** Two sibling nodes share the same name. */
    ERR_DUPLICATE_NAME,

    /** An extends/super reference names a node that does not exist. */
    ERR_UNRESOLVED_SUPER,

    /** A child node type/subType is not permitted under its parent. */
    ERR_INVALID_SUBTYPE_CHILD,

    /** An attribute name is not declared on the node's type. */
    ERR_UNKNOWN_ATTR,

    /**
     * A reserved structural keyword ({@code name}, {@code package}, {@code extends},
     * {@code abstract}, {@code overlay}, {@code isArray}, {@code children}, {@code value})
     * was written as an {@code @}-prefixed attribute in canonical JSON.
     * The rule is unconditional — write the key bare.
     */
    ERR_RESERVED_ATTR,

    /** A required attribute is absent from the node. */
    ERR_MISSING_REQUIRED_ATTR,

    /** An attribute value fails its declared schema (type/range). */
    ERR_BAD_ATTR_VALUE,

    /** A layout @defaultSortField names a field absent from the entity. */
    ERR_BAD_DEFAULT_SORT_FIELD,

    /** Provider composition has a dependency cycle. */
    ERR_PROVIDER_DEPENDENCY_CYCLE,

    /** Two providers in a composition share the same id. */
    ERR_PROVIDER_DUPLICATE_ID,

    /** A provider declares a dependency id with no matching provider. */
    ERR_PROVIDER_MISSING_DEPENDENCY,

    /** A provider extend redefines an attr another provider already declared. */
    ERR_PROVIDER_ATTR_CONFLICT,

    /** A node violates a subtype composition rule. */
    ERR_SUBTYPE_RULE_VIOLATION,

    /** An overlay node has no existing target to merge into. */
    ERR_OVERLAY_NO_TARGET,

    /** The YAML metadata input is not valid YAML, or cannot be desugared. */
    ERR_MALFORMED_YAML,

    /**
     * A YAML 1.2 silent type coercion produced a value whose runtime type differs from
     * the attribute's declared valueType (e.g. an unquoted {@code column: TRUE} parsed
     * as boolean for a string-typed attr). Emitted only by the YAML loader; canonical
     * JSON is unaffected.
     */
    ERR_YAML_COERCION,

    /** A field origin (passthrough/aggregate) declares an invalid path or attribute. */
    ERR_INVALID_ORIGIN,

    /** A template declares a @payloadRef that does not resolve, or @requiredSlots that are not fields. */
    ERR_INVALID_TEMPLATE,

    /** Build-time verify: a template variable references a field the payload does not declare. */
    ERR_VAR_NOT_ON_PAYLOAD,

    /** Build-time verify: a template partial does not resolve in the configured provider. */
    ERR_PARTIAL_UNRESOLVED,

    /** Build-time verify (warning): a template's declared @requiredSlots slot is never referenced. */
    ERR_REQUIRED_SLOT_UNUSED,

    /**
     * Build-time verify: a template declares @requiredTags but its text omits a required
     * output tag's opening or closing form.
     */
    ERR_OUTPUT_TAG_MISSING,

    /** A dataGrid @filter references a non-filterable field or uses a disallowed op. */
    ERR_BAD_ATTR_FILTER,

    /** @storage "flattened" cannot be combined with isArray=true. */
    ERR_STORAGE_FLATTENED_ARRAY,

    /** @storage was set on a field that has no @objectRef. */
    ERR_STORAGE_WITHOUT_OBJECT_REF,

    /** An object declares source nodes but none has role=primary. */
    ERR_SOURCE_NO_PRIMARY,

    /** An object declares more than one source node with role=primary. */
    ERR_SOURCE_MULTIPLE_PRIMARY,

    /** An internal loader error with no stable error code. */
    ERR_UNKNOWN,
}
