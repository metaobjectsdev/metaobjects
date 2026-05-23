/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.field;

import com.metaobjects.DataTypes;
import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.MetaAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.util.ErrorMessageConstants;
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
 * enforces this contract; call it after loading to validate the content.  A
 * load-time-enforcement hook is deferred (see the comment in
 * {@link #registerTypes(MetaDataRegistry)}).</p>
 *
 * @version 6.0
 */
public class EnumField extends PrimitiveField<String> {

    private static final Logger log = LoggerFactory.getLogger(EnumField.class);

    // === SUBTYPE CONSTANT ===
    /** Enum field subtype constant — cross-language vocabulary. */
    public static final String SUBTYPE_ENUM = "enum";

    // === ATTRIBUTE CONSTANT ===
    /**
     * Name of the required string-array attribute that lists member symbols.
     * Cross-language vocabulary: {@code @values} in canonical JSON.
     */
    public static final String ATTR_VALUES = "values";

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
     * available via the static {@link #validateEnumValues(Object)} method.  Wiring it
     * as a load-time constraint is deferred because the constraint enforcer fires at
     * node-creation time (before {@code @values} is parsed), so enforcement would
     * require a dedicated post-parse validation pass.</p>
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
            });

            log.debug("Registered EnumField type with required @values attribute and member validation");

        } catch (Exception e) {
            log.error("Failed to register EnumField type with unified registry", e);
        }
    }

    // -----------------------------------------------------------------------
    // Post-parse validation hook — called by CanonicalJsonParser after the
    // full field.enum node (attributes + children) has been built.
    // -----------------------------------------------------------------------

    /**
     * Post-parse validation for a freshly-built {@code field.enum} node.
     *
     * <p>Enforces the cross-language {@code @values} contract at load time:</p>
     * <ol>
     *   <li>Missing {@code @values} → throws with {@code ERR_MISSING_REQUIRED_ATTR}</li>
     *   <li>Empty / non-identifier member / duplicate → throws with {@code ERR_BAD_ATTR_VALUE}</li>
     * </ol>
     *
     * <p>Called from {@code CanonicalJsonParser.processNode()} after the node's
     * attributes and children have been processed, so {@code @values} is already
     * set on the node.  Mirrors the TS and C# loader validation that fires at the
     * equivalent point in those pipelines.</p>
     *
     * @param enumNode the {@code field.enum} node to validate; ignored if not
     *                 type=field / subtype=enum
     * @param filename the source filename — included in error messages
     * @throws MetaDataException with code {@code ERR_MISSING_REQUIRED_ATTR} if
     *         {@code @values} is absent, or {@code ERR_BAD_ATTR_VALUE} if the
     *         members fail the identifier / uniqueness contract
     */
    public static void validateNodeAfterParse(MetaData enumNode, String filename) {
        if (enumNode == null) return;
        if (!TYPE_FIELD.equals(enumNode.getType()) || !SUBTYPE_ENUM.equals(enumNode.getSubType())) return;

        // --- Content check (own @values only) ---
        // Validate OWN @values regardless of whether the node is abstract or concrete.
        // A node that merely inherits @values from a super has nothing to content-validate here.
        // This matches the TS (attr-schema-validate.ts) and C# (ValidationPasses.ValidateEnumValues)
        // own-only contracts.
        if (enumNode.hasMetaAttr(ATTR_VALUES, false)) {
            MetaAttribute<?> valuesAttr;
            try {
                @SuppressWarnings("unchecked")
                MetaAttribute<?> attr = (MetaAttribute<?>) enumNode.getMetaAttr(ATTR_VALUES, false);
                valuesAttr = attr;
            } catch (Exception e) {
                // hasMetaAttr(false) returned true above, so this should not occur in practice.
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR + ": field.enum '" + enumNode.getName()
                        + "' could not read own @values attribute in file [" + filename + "]", e);
            }
            if (!validateEnumValues(valuesAttr.getValue())) {
                throw new MetaDataException(
                    ErrorMessageConstants.ERR_BAD_ATTR_VALUE + ": field.enum '" + enumNode.getName()
                        + "' @values must be a non-empty list of identifier-safe, unique members"
                        + " (e.g. [\"DRAFT\",\"PUBLISHED\"]) in file [" + filename + "]");
            }
            // Own @values present and valid — no need for the required check below.
            return;
        }

        // --- Required check ---
        // The node has no own @values. It is valid ONLY if it has a super reference
        // (inheriting @values from the super, which is validated on its own node).
        // getSuperData() is non-null iff an "extends" was given AND the super was found
        // (if extends was given but not found, BaseMetaDataParser already threw).
        // This check is therefore load-order-independent — no dependency on getSuperData()
        // resolution state beyond the guarantee that createOrOverlayMetaData provides.
        if (enumNode.getSuperData() == null) {
            throw new MetaDataException(
                ErrorMessageConstants.ERR_MISSING_REQUIRED_ATTR + ": field.enum '" + enumNode.getName()
                    + "' is missing required @values attribute in file [" + filename + "]");
        }
        // Has a super — inherits @values from the super, which is validated on its own node. OK.
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
