/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.field;

import com.metaobjects.DataTypes;
import com.metaobjects.attr.BooleanAttribute;
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
     * Consumed by FR-010 extract: maps raw input tokens to their canonical enum member.
     * Cross-language vocabulary: {@code @enumAlias} in canonical JSON.
     */
    public static final String ATTR_ENUM_ALIAS = "enumAlias";

    /**
     * FR-019: name of the optional {@code @provided} boolean attribute — own-only on an
     * <em>abstract</em> package-level {@code field.enum} declaration. When {@code true}, codegen
     * does NOT materialize the enum type; consuming fields reference an existing hand-written /
     * third-party type, resolved via per-port codegen config (the namespace/FQN never lives in
     * metadata — ADR-0001). Default {@code false}. Placing {@code @provided} on a concrete consuming
     * field is invalid. A non-boolean value is rejected at load with {@code ERR_BAD_ATTR_VALUE} (the
     * {@link BooleanAttribute} enum constraint). Cross-language vocabulary: {@code @provided} in
     * canonical JSON. See ADR-0026.
     */
    public static final String ATTR_PROVIDED = "provided";

    /**
     * Name of the optional per-member explicit-integer-value attribute
     * ({@code {member: int}}), switching this enum field's DB persistence from
     * string+CHECK to integer+CHECK. Keys must exactly match the field's effective
     * {@code @values}; values must be unique integers ({@code ERR_BAD_ATTR_VALUE}
     * otherwise — enforced post-load in
     * {@link com.metaobjects.loader.ValidationPhase}). The generic "is this an
     * object of integers" shape check runs in {@link com.metaobjects.attr.IntMapAttribute}
     * itself. Cross-language vocabulary: {@code @intValueMap} in canonical JSON.
     */
    public static final String ATTR_INT_VALUE_MAP = "intValueMap";

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
     * Member symbol used by tolerant extract as the fallback when a present-but-uncoercible
     * value is seen → the field classifies as {@code DEFAULTED}. Loader-validated to be one
     * of the field's effective {@code @values} ({@code ERR_BAD_ATTR_VALUE} otherwise).
     * Cross-language vocabulary: {@code @coerceDefault} in canonical JSON.
     */
    public static final String ATTR_COERCE_DEFAULT = "coerceDefault";

    /**
     * Name of the optional {@code @default} attribute (string) — the absent-fill member.
     * When the field is ABSENT from the model response, tolerant extract fills this value and
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
     * applied during tolerant enum extract. On {@code field.enum} it is per-field; on
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

                // FR-033: @enumAlias is re-homed to the metaobjects-prompt concern
                // provider (reads spec/metamodel/prompt.json's field.enum extends).

                // FR-019: optional @provided boolean — marks an abstract package-level enum as
                // externally provided (codegen references it instead of materializing). The
                // BooleanAttribute enum constraint rejects a non-boolean value (ERR_BAD_ATTR_VALUE).
                // Mirrors the @symmetric (relationship) boolean registration. See ADR-0026.
                def.optionalAttributeWithConstraints(ATTR_PROVIDED)
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN)
                   .asSingle();

                // Optional @intValueMap — an object-shaped attribute whose values
                // are all integers. Key-set-matches-@values and uniqueness are
                // validated post-load in ValidationPhase (own-only, same as @values).
                def.optionalAttributeWithConstraints(ATTR_INT_VALUE_MAP)
                   .ofType(com.metaobjects.attr.IntMapAttribute.SUBTYPE_INT_MAP)
                   .asSingle();

                // FR-033: @enumDoc and @coerceDefault are re-homed to the
                // metaobjects-prompt concern provider (reads
                // spec/metamodel/prompt.json's field.enum extends).

                // Phase B: @default (absent-fill member) is registered on the field base
                // (MetaField.ATTR_DEFAULT) and inherited via field.base — no enum-specific
                // registration. Enum-membership of its value is still validated post-load in
                // ValidationPhase.

                // FR-033: @normalize (closed-enum none|collapse|strip) is re-homed to
                // the metaobjects-prompt concern provider (reads
                // spec/metamodel/prompt.json's field.enum extends). The closed-set
                // value check still runs post-load in ValidationPhase.
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
