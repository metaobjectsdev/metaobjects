/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.field;

import com.metaobjects.DataTypes;
import com.metaobjects.attr.PropertiesAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * An Enum Field with a required {@code @values} string-array attribute.
 *
 * <p>Members are identifier-safe symbols (matching {@link #ENUM_MEMBER_PATTERN}),
 * stored as their own string value. No integer-backing in v1.</p>
 *
 * <p>The {@code @values} array must be non-empty, contain no duplicates, and every
 * member must match {@code ^[A-Za-z_][A-Za-z0-9_]*$}.  These constraints mirror the
 * cross-language validation contract shared with TS and C# (conformance error code
 * {@code ERR_BAD_ATTR_VALUE}).  The static {@link #validateEnumValues(Object)} method
 * is the lower-level content helper; the loader's
 * {@link com.metaobjects.loader.ValidationPhase} invokes it in a post-load pass to
 * enforce this contract.</p>
 *
 * @version 6.0
 */
public class EnumField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(EnumField.class);

    // === SUBTYPE CONSTANT ===
    /** Enum field subtype constant — cross-language vocabulary. */
    public static final String SUBTYPE_ENUM = "enum";

    // === ATTRIBUTE CONSTANTS ===
    /**
     * Name of the required string-array attribute that lists member symbols.
     * Cross-language vocabulary: {@code @values} in canonical JSON.
     */
    public static final String ATTR_VALUES = "values";

    /**
     * Name of the optional off-vocabulary → canonical-member alias map (properties).
     * Consumed by FR-010 recover: maps raw input tokens to their canonical enum member.
     * Cross-language vocabulary: {@code @enumAlias} in canonical JSON.
     */
    public static final String ATTR_ENUM_ALIAS = "enumAlias";

    /**
     * Name of the optional per-member description map (properties).
     * Each key is an enum member symbol from {@code @values}; the value is a
     * human-readable (or LLM-facing) description of that member.
     * Consumed by FR-010 output-format prompt fragment generation.
     * Cross-language vocabulary: {@code @enumDoc} in canonical JSON.
     */
    public static final String ATTR_ENUM_DOC = "enumDoc";

    /**
     * Name of the optional FR-011 {@code @coerceDefault} attribute (string).
     * Member symbol used by tolerant recover as the fallback when a present-but-uncoercible
     * value is seen → the field classifies as {@code DEFAULTED}. Loader-validated to be one
     * of the field's effective {@code @values} ({@code ERR_BAD_ATTR_VALUE} otherwise).
     * Cross-language vocabulary: {@code @coerceDefault} in canonical JSON.
     */
    public static final String ATTR_COERCE_DEFAULT = "coerceDefault";

    /**
     * Name of the optional {@code @default} attribute (string) — the absent-fill member.
     * When the field is ABSENT from the model response, tolerant recover fills this value and
     * classifies the field {@code DEFAULTED} (which satisfies {@code required}). Loader-validated
     * to be one of the field's effective {@code @values}.
     *
     * <p>Phase B: the {@code @default} attribute is now registered on the field base
     * ({@link MetaField#ATTR_DEFAULT}) so ANY field type may declare it; this alias preserves the
     * FR-011 reference site. Distinct from the framework's legacy {@code @defaultValue}
     * (column default). Cross-language vocabulary: {@code @default} in canonical JSON.</p>
     */
    public static final String ATTR_DEFAULT = MetaField.ATTR_DEFAULT;

    /**
     * Name of the optional FR-011 {@code @normalize} attribute (closed enum
     * {@code none|collapse|strip}, default {@code strip}). Controls the ASCII normalization
     * applied during tolerant enum recover. On {@code field.enum} it is per-field; on
     * {@code object.value} it is the object-level default for its enum fields.
     * Cross-language vocabulary: {@code @normalize} in canonical JSON.
     */
    public static final String ATTR_NORMALIZE = "normalize";

    /** FR-011: {@code @normalize} mode — exact match only (no normalization). */
    public static final String NORMALIZE_NONE = "none";

    /** FR-011: {@code @normalize} mode — ASCII-upper + trim + collapse runs of {@code [\s_-]+} to {@code _}. */
    public static final String NORMALIZE_COLLAPSE = "collapse";

    /** FR-011: {@code @normalize} mode — ASCII-upper + keep only {@code [A-Z0-9]}. The default. */
    public static final String NORMALIZE_STRIP = "strip";

    /** FR-011: the default {@code @normalize} mode when absent on both field and owning object. */
    public static final String NORMALIZE_DEFAULT = NORMALIZE_STRIP;

    /** FR-011: the closed set of valid {@code @normalize} modes. */
    public static final java.util.List<String> NORMALIZE_MODES =
        java.util.List.of(NORMALIZE_NONE, NORMALIZE_COLLAPSE, NORMALIZE_STRIP);

    /**
     * Per-member identifier pattern — enforced at load time.
     * Every element of {@code @values} must be a legal identifier in every
     * target language (Java, TypeScript, C#, Python) AND a stable stored string,
     * so the symbol == stored value with no name&harr;value divergence.
     *
     * <p>Mirrors {@code ENUM_MEMBER_PATTERN} in the TS and C# ports.</p>
     */
    public static final Pattern ENUM_MEMBER_PATTERN = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");

    // -----------------------------------------------------------------------

    public EnumField(String name) {
        super(SUBTYPE_ENUM, name, DataTypes.STRING);
    }

    // -----------------------------------------------------------------------
    // Registry self-registration
    // -----------------------------------------------------------------------

    /**
     * Register the {@code field.enum} type with the MetaDataRegistry.
     *
     * <p>Declares a <strong>required</strong> {@code @values} string-array attribute.
     * Java string arrays use {@code StringAttribute} with {@code isArray=true} (the
     * {@code attr.stringarray} type was removed; the pattern mirrors {@code identity.primary
     * @fields}).  Per-element content validation (non-empty, identifier-safe members,
     * no duplicates — equivalent to cross-language {@code ERR_BAD_ATTR_VALUE}) is
     * available via the static {@link #validateEnumValues(Object)} method.  It is not
     * wired as a node-creation constraint because the constraint enforcer fires before
     * {@code @values} is parsed; instead the loader's
     * {@link com.metaobjects.loader.ValidationPhase} runs it as a dedicated post-load
     * validation pass.</p>
     *
     * @param registry The MetaDataRegistry to register with
     */
    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(EnumField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_ENUM)
                   .description(
                       "Enum field: value constrained to the @values member set. " +
                       "Members are identifier-safe symbols stored as their own string value.")

                   // Inherit all common field attributes (isArray, required, etc.)
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);

                // Required @values string-array attribute — the member symbol list.
                // Mirrors PrimaryIdentity's @fields: StringAttribute + .asArray().
                def.requiredAttributeWithConstraints(ATTR_VALUES)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .asArray();

                // Optional @enumAlias properties attribute — off-vocabulary → canonical-member map.
                // Consumed by FR-010 recover; not validated at load time.
                def.optionalAttributeWithConstraints(ATTR_ENUM_ALIAS)
                   .ofType(PropertiesAttribute.SUBTYPE_PROPERTIES)
                   .asSingle();

                // Optional @enumDoc properties attribute — per-member description map.
                // Consumed by FR-010 output-format prompt fragment; not validated at load time.
                def.optionalAttributeWithConstraints(ATTR_ENUM_DOC)
                   .ofType(PropertiesAttribute.SUBTYPE_PROPERTIES)
                   .asSingle();

                // FR-011: optional @coerceDefault string — present-but-uncoercible recover
                // fallback member. Membership against @values is validated post-load in
                // ValidationPhase (ERR_BAD_ATTR_VALUE), mirroring the @values content pass.
                def.optionalAttributeWithConstraints(ATTR_COERCE_DEFAULT)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .asSingle();

                // Phase B: @default (absent-fill member) is registered on the field base
                // (MetaField.ATTR_DEFAULT) and inherited via field.base — no enum-specific
                // registration. Enum-membership of its value is still validated post-load in
                // ValidationPhase.

                // FR-011: optional @normalize closed-enum string (none|collapse|strip, default
                // strip). The withEnum constraint records the vocabulary; ValidationPhase also
                // re-checks it post-load (belt-and-braces, matching source @kind/@role).
                def.optionalAttributeWithConstraints(ATTR_NORMALIZE)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .withEnum(NORMALIZE_NONE, NORMALIZE_COLLAPSE, NORMALIZE_STRIP);
            });

            log.debug("Registered EnumField type with required @values attribute and member validation");

        } catch (Exception e) {
            log.error("Failed to register EnumField type with unified registry", e);
        }
    }

    // -----------------------------------------------------------------------
    // @values validation — cross-language contract
    // -----------------------------------------------------------------------

    /**
     * Validates the raw {@code @values} attribute value against the cross-language
     * enum-member contract:
     *
     * <ol>
     *   <li>Non-null and non-empty (at least one member).</li>
     *   <li>Every element is a non-empty string matching {@link #ENUM_MEMBER_PATTERN}
     *       ({@code ^[A-Za-z_][A-Za-z0-9_]*$}).</li>
     *   <li>No duplicate members (case-sensitive).</li>
     * </ol>
     *
     * <p>Returns {@code false} on any violation so the constraint framework can
     * reject the value.  A {@code null} value is treated as invalid (the attribute
     * is required; a separate required-check catches the null case).</p>
     *
     * @param value the raw attribute value — may be a {@code List<String>}
     *              (from an already-parsed attribute) or a comma-delimited {@code String}
     * @return {@code true} if the values satisfy the contract; {@code false} otherwise
     */
    @SuppressWarnings("unchecked")
    public static boolean validateEnumValues(Object value) {
        if (value == null) {
            // Null is handled by the required-attribute check; return false to avoid
            // double-fault during load.
            return false;
        }

        // Normalise the comma-delimited String form (programmatic/direct-call path) into
        // a List so the shared member/duplicate check below handles both forms identically.
        // The List form is the normal load-time path (setArray-before-setValueAsString fix
        // means the parser always produces a List).
        List<String> members;
        if (value instanceof List) {
            members = (List<String>) value;
        } else if (value instanceof String) {
            String str = ((String) value).trim();
            if (str.isEmpty()) {
                return false; // empty string → ERR_BAD_ATTR_VALUE (empty array)
            }
            String[] tokens = str.split(",");
            List<String> list = new ArrayList<>(tokens.length);
            for (String token : tokens) {
                list.add(token.trim());
            }
            members = list;
        } else {
            return false; // unexpected type
        }

        // Non-empty
        if (members.isEmpty()) {
            return false;
        }

        // Identifier-safe + no duplicates (shared check for both List and String inputs)
        Set<String> seen = new HashSet<>();
        for (String member : members) {
            if (member == null || member.isEmpty() || !ENUM_MEMBER_PATTERN.matcher(member).matches()) {
                return false;
            }
            if (!seen.add(member)) {
                return false; // duplicate
            }
        }
        return true;
    }
}
