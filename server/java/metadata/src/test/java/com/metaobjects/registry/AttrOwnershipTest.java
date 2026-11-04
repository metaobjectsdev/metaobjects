package com.metaobjects.registry;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;
import org.junit.Test;

import java.util.List;
import java.util.function.Consumer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * ADR-0062 — the registry records which provider registered each attribute and refuses a
 * second provider's claim on the same name. The cross-port scenarios live in
 * {@code fixtures/provider-composition-conformance/}; this class pins what the shared corpus
 * cannot (message text, same-slot extend, unowned registrations, the shipped core).
 */
public class AttrOwnershipTest {

    static final class RootTemplate extends MetaTemplate {
        RootTemplate(String name) { super(TemplateConstants.SUBTYPE_BASE, name); }
    }

    static final class ProbeTemplate extends MetaTemplate {
        ProbeTemplate(String name) { super("probe", name); }
    }

    static final class SiblingTemplate extends MetaTemplate {
        SiblingTemplate(String name) { super("sibling", name); }
    }

    private static void root(MetaDataRegistry r, String attr) {
        r.registerType(RootTemplate.class, def -> {
            def.type(TemplateConstants.TYPE_TEMPLATE).subType(TemplateConstants.SUBTYPE_BASE).description("root");
            def.optionalAttributeWithConstraints(attr).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    private static void probe(MetaDataRegistry r, String attr) {
        r.registerType(ProbeTemplate.class, def -> {
            def.type(TemplateConstants.TYPE_TEMPLATE).subType("probe").description("probe")
               .inheritsFrom(TemplateConstants.TYPE_TEMPLATE, TemplateConstants.SUBTYPE_BASE);
            def.optionalAttributeWithConstraints(attr).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    private static void sibling(MetaDataRegistry r, String attr) {
        r.registerType(SiblingTemplate.class, def -> {
            def.type(TemplateConstants.TYPE_TEMPLATE).subType("sibling").description("sibling");
            def.optionalAttributeWithConstraints(attr).ofType(StringAttribute.SUBTYPE_STRING).asSingle();
        });
    }

    private static MetaDataTypeProvider provider(String id, String[] deps, Consumer<MetaDataRegistry> body) {
        return new MetaDataTypeProvider() {
            @Override public String getProviderId() { return id; }
            @Override public String[] getDependencies() { return deps; }
            @Override public void registerTypes(MetaDataRegistry registry) { body.accept(registry); }
            @Override public String getDescription() { return "test " + id; }
        };
    }

    private static MetaDataException refusal(MetaDataTypeProvider... providers) {
        try {
            MetaDataRegistry.compose(List.of(providers));
        } catch (MetaDataException e) {
            return e;
        }
        fail("expected the composition to be refused");
        return null;
    }

    @Test
    public void shadowingRegistrationNamesBothProvidersAndTheAttribute() {
        MetaDataException e = refusal(
            provider("owner-a", new String[0], r -> root(r, "physicalName")),
            provider("owner-b", new String[]{"owner-a"}, r -> probe(r, "physicalName")));
        assertEquals(ErrorCode.ERR_PROVIDER_ATTR_SHADOW, e.getCode().orElseThrow());
        assertTrue(e.getMessage().contains("owner-a"));
        assertTrue(e.getMessage().contains("owner-b"));
        assertTrue(e.getMessage().contains("physicalName"));
    }

    @Test
    public void extendOntoTheSharedRootCollidesWithASubtypeName() {
        MetaDataException e = refusal(
            provider("owner-a", new String[0], r -> {
                root(r, "other");
                probe(r, "physicalName");
            }),
            provider("owner-b", new String[]{"owner-a"}, r ->
                r.extendType(RootTemplate.class, def ->
                    def.optionalAttributeWithConstraints("physicalName")
                       .ofType(StringAttribute.SUBTYPE_STRING).asSingle())));
        assertEquals(ErrorCode.ERR_PROVIDER_ATTR_SHADOW, e.getCode().orElseThrow());
    }

    @Test
    public void extendingASubtypeWithANameItOnlyInheritsIsAShadowEvenWhenTheSpecDiffers() {
        MetaDataException e = refusal(
            provider("owner-a", new String[0], r -> {
                root(r, "physicalName");
                probe(r, "other");
            }),
            provider("owner-b", new String[]{"owner-a"}, r ->
                r.extendType(ProbeTemplate.class, def ->
                    def.optionalAttributeWithConstraints("physicalName")
                       .ofType(StringAttribute.SUBTYPE_STRING).asArray())));
        assertEquals(ErrorCode.ERR_PROVIDER_ATTR_SHADOW, e.getCode().orElseThrow());
    }

    @Test
    public void ownerExtendingItsSubtypeWithAnInheritedNameIsLegalAndRecorded() {
        MetaDataRegistry registry = MetaDataRegistry.compose(List.of(
            provider("owner-a", new String[0], r -> {
                root(r, "physicalName");
                probe(r, "other");
                r.extendType(ProbeTemplate.class, def ->
                    def.optionalAttributeWithConstraints("physicalName")
                       .ofType(StringAttribute.SUBTYPE_STRING).asSingle());
            })));
        assertEquals("owner-a", registry.getAttrProvider(TemplateConstants.TYPE_TEMPLATE, "probe", "physicalName"));
    }

    @Test
    public void sameSlotExtendByAnotherProviderKeepsAttrConflictAndNamesTheOwner() {
        MetaDataException e = refusal(
            provider("owner-a", new String[0], r -> probe(r, "physicalName")),
            provider("owner-b", new String[]{"owner-a"}, r ->
                r.extendType(ProbeTemplate.class, def ->
                    def.optionalAttributeWithConstraints("physicalName")
                       .ofType(StringAttribute.SUBTYPE_STRING).asSingle())));
        assertEquals(ErrorCode.ERR_PROVIDER_ATTR_CONFLICT, e.getCode().orElseThrow());
        assertTrue(e.getMessage().contains("owner-a"));
        assertTrue(e.getMessage().contains("owner-b"));
    }

    @Test
    public void siblingSubtypesMayUseOneName() {
        MetaDataRegistry registry = MetaDataRegistry.compose(List.of(
            provider("owner-a", new String[0], r -> probe(r, "physicalName")),
            provider("owner-b", new String[]{"owner-a"}, r -> sibling(r, "physicalName"))));
        assertEquals("owner-a", registry.getAttrProvider("template", "probe", "physicalName"));
        assertEquals("owner-b", registry.getAttrProvider("template", "sibling", "physicalName"));
    }

    @Test
    public void registrationOutsideAProviderTurnClaimsNothingAndCollidesWithNothing() {
        MetaDataRegistry registry = MetaDataRegistry.compose(List.of(
            provider("owner-a", new String[0], r -> root(r, "physicalName"))));
        // After compose no provider is running: unowned, so not refused.
        probe(registry, "physicalName");
        assertEquals("owner-a", registry.getAttrProvider("template", "base", "physicalName"));
        assertNull(registry.getAttrProvider("template", "probe", "physicalName"));
    }

    @Test
    public void shippedCoreProvidersComposeWithNoCollisionAndNameTheirOwner() {
        // Composing the shipped core is itself the audit: any cross-provider claim on a
        // node type would throw ERR_PROVIDER_ATTR_SHADOW here.
        MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry(List.of());
        assertNotNull(registry.getAttrProvider("metadata", "base", "isAbstract"));
    }
}
