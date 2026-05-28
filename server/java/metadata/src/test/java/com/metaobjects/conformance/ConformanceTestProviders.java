/*
 * Test-only MetaDataTypeProvider fixtures used by the provider-extension-*
 * cross-port conformance fixtures.
 *
 * Mirrors the test adapter shipped by the TypeScript port
 * (server/typescript/packages/metadata/test/conformance/adapter.ts) and the
 * Python port (server/python/tests/conformance/conformance_adapter.py).
 *
 * Five fictional providers cover the four expected scenarios:
 *
 *   - cycle-a / cycle-b ............... surface ERR_PROVIDER_DEPENDENCY_CYCLE
 *   - duplicate-x / duplicate-x-clone . surface ERR_PROVIDER_DUPLICATE_ID
 *   - depends-on-missing .............. surfaces ERR_PROVIDER_MISSING_DEPENDENCY
 *   - example-template-briefing ....... registers a `template.briefing` subtype
 *                                       so the input file in the success fixture
 *                                       loads cleanly
 */
package com.metaobjects.conformance;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;

import java.util.Map;

final class ConformanceTestProviders {

    private ConformanceTestProviders() {}

    /**
     * Test-only `template.briefing` subtype. Fictional — not a real template kind
     * MO core ships. Used only by the provider-extension-new-subtype-success
     * fixture to exercise registry.registerType machinery without colliding with
     * real core subtypes. (Pre-ADR-0011 this fixture used a "toolcall" subtype;
     * now that template.toolcall is core, the test-only one moved to a clearly-
     * fictional name.)
     */
    public static final class BriefingTemplate extends MetaTemplate {
        public BriefingTemplate(String name) {
            super("briefing", name);
        }

        public static void registerTypes(MetaDataRegistry registry) {
            registry.registerType(BriefingTemplate.class, def -> {
                def.type(TemplateConstants.TYPE_TEMPLATE).subType("briefing")
                   .description("Test-only template.briefing — provider-extension fixture only")
                   .inheritsFrom(TemplateConstants.TYPE_TEMPLATE, TemplateConstants.SUBTYPE_BASE);
                def.requiredAttributeWithConstraints("payloadRef")
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.requiredAttributeWithConstraints("author")
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
                def.requiredAttributeWithConstraints("recipient")
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            });
        }
    }

    public static final MetaDataTypeProvider EXAMPLE_TEMPLATE_BRIEFING = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "example-template-briefing"; }
        @Override public String[] getDependencies() { return new String[]{"metaobjects-core-types"}; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            BriefingTemplate.registerTypes(registry);
        }
        @Override public String getDescription() { return "Test-only: registers a fictional template.briefing subtype."; }
    };

    public static final MetaDataTypeProvider CYCLE_A = noop("cycle-a", "cycle-b");
    public static final MetaDataTypeProvider CYCLE_B = noop("cycle-b", "cycle-a");
    public static final MetaDataTypeProvider DEPENDS_ON_MISSING = noop("depends-on-missing", "does-not-exist");
    public static final MetaDataTypeProvider DUPLICATE_X = noop("duplicate-x");
    /** Same `.getProviderId()` as DUPLICATE_X — compose() throws ERR_PROVIDER_DUPLICATE_ID. */
    public static final MetaDataTypeProvider DUPLICATE_X_CLONE = noop("duplicate-x");

    /**
     * Provider-id → provider object. The fixture corpus names providers by their
     * stable id (e.g. "cycle-a"); the conformance runner resolves those ids to
     * the actual provider objects to compose a registry. The map's key for
     * DUPLICATE_X_CLONE is `"duplicate-x-clone"` (different from its
     * getProviderId(), which is `"duplicate-x"` to surface the collision).
     */
    public static final Map<String, MetaDataTypeProvider> TEST_PROVIDERS = Map.of(
        "example-template-briefing", EXAMPLE_TEMPLATE_BRIEFING,
        "cycle-a", CYCLE_A,
        "cycle-b", CYCLE_B,
        "depends-on-missing", DEPENDS_ON_MISSING,
        "duplicate-x", DUPLICATE_X,
        "duplicate-x-clone", DUPLICATE_X_CLONE
    );

    private static MetaDataTypeProvider noop(String providerId, String... dependencies) {
        return new MetaDataTypeProvider() {
            @Override public String getProviderId() { return providerId; }
            @Override public String[] getDependencies() { return dependencies; }
            @Override public void registerTypes(MetaDataRegistry registry) { /* no-op */ }
            @Override public String getDescription() { return "Test-only noop provider: " + providerId; }
        };
    }
}
