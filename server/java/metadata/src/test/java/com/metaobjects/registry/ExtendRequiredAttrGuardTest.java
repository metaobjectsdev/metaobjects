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
package com.metaobjects.registry;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.registry.spec.SpecMetamodelReader;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

/**
 * ADR-0050 — a REQUIRED attr may never be PROJECTED onto a type another provider
 * owns. Projection is optional-only: a required attr registered this way
 * disappears silently whenever the projecting provider is composed out, taking
 * its validation rule with it (exactly how FR-033 broke {@code template.*}'s
 * {@code @payloadRef} / {@code @toolName} — see ADR-0050 and the TypeScript
 * {@code registry.ts} {@code TypeRegistry.extend} guard this mirrors).
 *
 * <p>Covers all three Java entry points a provider uses to decorate a type it
 * does not own:</p>
 * <ul>
 *   <li>{@link MetaDataRegistry#applyExtendsAttrs} — the FR-033 spec-JSON
 *       {@code extends} path {@code metaobjects-ui} / {@code metaobjects-prompt}
 *       drive via the public {@link MetaDataRegistry#applyProviderExtends}.
 *       Package-private specifically so this test can hand it a constructed
 *       {@code List<ExtendsAttr>} directly — the Java analogue of the TS
 *       registry test calling {@code applyProviderDefinition} with a
 *       constructed {@code ProviderDefinition}, without needing a throwaway
 *       classpath spec file just to drive the public entry point end-to-end.</li>
 *   <li>{@link MetaDataRegistry#extendType} — the native Java provider-extension
 *       path {@code metaobjects-db} (CoreDBMetaDataProvider) uses to project
 *       {@code @orders}/{@code @where}/{@code @expr}/{@code @using} onto
 *       {@code identity.secondary} / {@code index.lookup}.</li>
 *   <li>{@link TypeExtensionBuilder} (via {@link MetaDataRegistry#findType}) —
 *       the older fluent-builder projection path, live in production via
 *       codegen-base's AI-documentation / JSON-schema generators (currently
 *       optional-only).</li>
 * </ul>
 *
 * <p>{@code metaobjects-documentation}'s projection
 * ({@link MetaDataRegistry#registerCommonAttribute}) needs no guard and none is
 * added: that method has no {@code required} parameter at all, so a required
 * common attr is structurally inexpressible.</p>
 */
public class ExtendRequiredAttrGuardTest {

    // ------------------------------------------------------------------
    // applyExtendsAttrs — the FR-033 spec-JSON extends path.
    // ------------------------------------------------------------------

    @Test
    public void applyExtendsAttrs_requiredAttr_throwsAndDoesNotApply() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        MetaDataException ex = assertThrows(MetaDataException.class, () ->
            registry.applyExtendsAttrs("field", "string", List.of(
                new SpecMetamodelReader.ExtendsAttr("mustBeThere", "string", false, true))));

        assertEquals(ErrorCode.ERR_EXTEND_REQUIRED_ATTR, ex.getCode().orElse(null));
        assertNull("the required attr must not be half-applied (fails closed)",
            registry.getChildRequirement("field", "string", "mustBeThere"));
    }

    @Test
    public void applyExtendsAttrs_optionalAttr_appliesNormally() {
        // Lowering coverage for the legitimate case: an optional projected attr is
        // exactly what metaobjects-ui / metaobjects-prompt do via applyProviderExtends.
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        registry.applyExtendsAttrs("field", "string", List.of(
            new SpecMetamodelReader.ExtendsAttr("aProjectedOptionalAttr", "string", false, false)));

        ChildRequirement req = registry.getChildRequirement("field", "string", "aProjectedOptionalAttr");
        assertNotNull("optional projected attr should be applied", req);
        assertFalse("optional projected attr should stay optional", req.isRequired());
    }

    // ------------------------------------------------------------------
    // extendType — the native Java provider-extension path.
    // ------------------------------------------------------------------

    @Test
    public void extendType_requiredAttr_throwsAndDoesNotApply() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        MetaDataException ex = assertThrows(MetaDataException.class, () ->
            registry.extendType(StringField.class, def ->
                def.requiredAttribute("mustBeThereToo", StringAttribute.SUBTYPE_STRING)));

        assertEquals(ErrorCode.ERR_EXTEND_REQUIRED_ATTR, ex.getCode().orElse(null));
        assertNull("the required attr must not be half-applied (fails closed)",
            registry.getChildRequirement("field", "string", "mustBeThereToo"));
    }

    @Test
    public void extendType_optionalAttr_appliesNormally() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        registry.extendType(StringField.class, def ->
            def.optionalAttribute("anotherProjectedOptionalAttr", StringAttribute.SUBTYPE_STRING));

        ChildRequirement req = registry.getChildRequirement("field", "string", "anotherProjectedOptionalAttr");
        assertNotNull("optional projected attr should be applied", req);
        assertFalse("optional projected attr should stay optional", req.isRequired());
    }

    // ------------------------------------------------------------------
    // TypeExtensionBuilder (MetaDataRegistry#findType).
    // ------------------------------------------------------------------

    @Test
    public void typeExtensionBuilder_requiredAttr_throws() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        MetaDataException ex = assertThrows(MetaDataException.class, () ->
            registry.findType("field", "string")
                .requiredAttribute("findTypeRequiredAttr", StringAttribute.SUBTYPE_STRING));

        assertEquals(ErrorCode.ERR_EXTEND_REQUIRED_ATTR, ex.getCode().orElse(null));
        assertNull("the required attr must not be half-applied (fails closed)",
            registry.getChildRequirement("field", "string", "findTypeRequiredAttr"));
    }

    @Test
    public void typeExtensionBuilder_optionalAttr_appliesNormally() {
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();

        registry.findType("field", "string")
            .optionalAttribute("findTypeOptionalAttr", StringAttribute.SUBTYPE_STRING);

        ChildRequirement req = registry.getChildRequirement("field", "string", "findTypeOptionalAttr");
        assertNotNull("optional projected attr should be applied", req);
        assertFalse("optional projected attr should stay optional", req.isRequired());
    }

    // ------------------------------------------------------------------
    // ADR-0050 sanity: the four legitimate concern-provider projections must
    // still compose cleanly under the guard.
    // ------------------------------------------------------------------

    @Test
    public void fourLegitimateProjectionsStillComposeCleanly() {
        // createWithCoreProviders() runs the FULL ServiceLoader provider set,
        // including CoreDBMetaDataProvider (extendType), UiTypesMetaDataProvider
        // and PromptTypesMetaDataProvider (applyProviderExtends), and
        // DocumentationMetaDataProvider (registerCommonAttribute). If the guard
        // wrongly rejected any of their real, shipped projections, registry
        // construction itself would throw here rather than in a downstream test.
        MetaDataRegistry registry = MetaDataRegistry.createWithCoreProviders();
        assertNotNull(registry);

        // Spot-check one attr from each of the three attr-carrying projections
        // (documentation's common attrs are asserted separately elsewhere; they
        // carry no required/optional distinction to guard).
        assertNotNull("metaobjects-db projects @orders onto identity.secondary",
            registry.getChildRequirement("identity", "secondary", "orders"));
        assertNotNull("metaobjects-ui/prompt project @xmlText onto every field.*",
            registry.getChildRequirement("field", "string", "xmlText"));
    }
}
