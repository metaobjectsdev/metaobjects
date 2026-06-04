/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.registry;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.constraint.PlacementConstraint;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0023 Decision 2 — the sealed registry. After the agreed metamodel
 * providers bootstrap, the registry is <strong>sealed</strong>: any further
 * registration ({@code register}/{@code extendType}/{@code registerCommonAttribute}/
 * {@code addConstraint}/{@code registerType}/{@code setDefaultSubType}/
 * {@code addGlobalChildRequirement}/{@code registerProviders}) throws
 * {@link ErrorCode#ERR_REGISTRY_SEALED}.
 *
 * <p>This is the structural backstop that makes "codegen makes up a metamodel
 * attribute" a hard failure: a codegen generator (or any post-bootstrap caller)
 * attempting to register a metamodel attr against a sealed registry throws —
 * the registration-time hard-fail gate (Decision 2 + Consequences).</p>
 */
public class SealedRegistryTest {

    /** A freshly-composed, then-sealed, defined-provider-set registry. */
    private static MetaDataRegistry sealedRegistry() {
        MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry();
        registry.seal();
        return registry;
    }

    private static void assertSealed(Runnable mutation) {
        try {
            mutation.run();
            fail("Expected ERR_REGISTRY_SEALED but mutation succeeded");
        } catch (MetaDataException e) {
            assertEquals("Sealed-registry mutation must carry ERR_REGISTRY_SEALED",
                    java.util.Optional.of(ErrorCode.ERR_REGISTRY_SEALED), e.getCode());
        }
    }

    @Test
    public void seal_isIdempotentAndQueryable() {
        MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry();
        assertFalse("a freshly composed registry is not sealed", registry.isSealed());
        registry.seal();
        assertTrue("seal() seals the registry", registry.isSealed());
        registry.seal(); // idempotent — no throw
        assertTrue(registry.isSealed());
    }

    @Test
    public void register_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        // A made-up subtype registration is the canonical "codegen invented a type" case.
        assertSealed(() -> registry.registerType(StringAttribute.class, def -> def
                .type("attr").subType("madeUpSubType")
                .description("a subtype no provider agreed on")));
    }

    @Test
    public void extendType_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        // The codegen-self-registration case: a generator extending a core type
        // with a made-up attribute (ai*/json*) against a sealed registry.
        assertSealed(() -> registry.extendType(com.metaobjects.field.StringField.class, def -> def
                .optionalAttribute("aiMadeUpAttr", StringAttribute.SUBTYPE_STRING)));
    }

    @Test
    public void registerCommonAttribute_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.registerCommonAttribute(
                "madeUpCommonAttr", StringAttribute.SUBTYPE_STRING, false));
    }

    @Test
    public void addConstraint_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.addConstraint(new PlacementConstraint(
                "sealed.test.placement", "a constraint added post-seal",
                "field", "string", "attr", "string", "madeUpAttr", true)));
    }

    @Test
    public void registerConstraint_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.registerConstraint(new PlacementConstraint(
                "sealed.test.placement2", "a constraint added post-seal",
                "field", "string", "attr", "string", "madeUpAttr2", true)));
    }

    @Test
    public void setDefaultSubType_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.setDefaultSubType("field", "madeUpDefault"));
    }

    @Test
    public void addGlobalChildRequirement_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.addGlobalChildRequirement("*", "*",
                new ChildRequirement("madeUp", "attr", "string", false)));
    }

    @Test
    public void registerProviders_afterSeal_throws() {
        MetaDataRegistry registry = sealedRegistry();
        assertSealed(() -> registry.registerProviders(RegistryManifest.metamodelProviders()));
    }

    @Test
    public void readPaths_afterSeal_stillWork() {
        // Sealing freezes WRITES only — reads (the loader's hot path) are unaffected.
        MetaDataRegistry registry = sealedRegistry();
        assertTrue("sealed registry still answers read queries",
                registry.getRegisteredTypes().size() > 0);
        assertEquals("root", registry.defaultSubTypeOf("metadata"));
    }
}
