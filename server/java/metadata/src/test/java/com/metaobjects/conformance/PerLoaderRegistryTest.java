package com.metaobjects.conformance;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.MetaDataRegistry;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Proves two loaders with different type registries in one JVM validate
 * independently (per-loader-registry design, success-criterion #3). A loader
 * whose registry knows {@code template.briefing} accepts it; a loader whose
 * registry does not rejects it — regardless of construction order, with no
 * global-singleton contamination.
 */
public class PerLoaderRegistryTest {

    // Structurally-valid canonical metadata declaring a template.briefing node
    // (mirrors fixtures/conformance/provider-extension-new-subtype-success input:
    // briefing requires @payloadRef -> an object.value, plus @author/@recipient).
    private static final String META =
        "{ \"metadata.root\": { \"package\": \"examples\", \"children\": ["
        + "  { \"object.value\": { \"name\": \"BriefingNotes\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"summary\" } },"
        + "      { \"field.string\": { \"name\": \"context\" } }"
        + "  ] } },"
        + "  { \"template.briefing\": { \"name\": \"DailyBriefing\","
        + "      \"@payloadRef\": \"BriefingNotes\","
        + "      \"@author\": \"Lorekeeper\", \"@recipient\": \"Council\" } }"
        + "] } }";

    private static MetaDataLoader newLoader(String name, MetaDataRegistry reg) {
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setTypeRegistry(reg);
        loader.init();
        return loader;
    }

    private static void load(MetaDataLoader loader) {
        loader.load(List.<MetaDataSource>of(new InMemoryStringSource(META, "meta.t.json")));
    }

    /** Registry WITH briefing -> load succeeds (must not throw). */
    private static void assertAccepts(MetaDataRegistry reg) {
        load(newLoader("with-briefing", reg));
    }

    /** Registry WITHOUT briefing -> load fails (unknown subtype / not accepted). */
    private static void assertRejects(MetaDataRegistry reg) {
        try {
            load(newLoader("without-briefing", reg));
            fail("expected load to fail: template.briefing is unknown in this registry");
        } catch (MetaDataException expected) {
            String m = String.valueOf(expected.getMessage());
            assertTrue("expected an unknown-subtype/not-accepted failure, got: " + m,
                m.contains("UNKNOWN_SUBTYPE")
                || m.contains("does not accept child")
                || m.contains("briefing"));
        }
    }

    @Test
    public void twoLoadersValidateIndependently_withFirst() {
        MetaDataRegistry withBriefing = MetaDataRegistry.createWithCoreProviders();
        ConformanceTestProviders.BriefingTemplate.registerTypes(withBriefing);
        MetaDataRegistry withoutBriefing = MetaDataRegistry.createWithCoreProviders();

        assertAccepts(withBriefing);
        assertRejects(withoutBriefing);
    }

    @Test
    public void twoLoadersValidateIndependently_withoutFirst() {
        // Reverse order: proves no ordering dependency / no global contamination.
        MetaDataRegistry withoutBriefing = MetaDataRegistry.createWithCoreProviders();
        MetaDataRegistry withBriefing = MetaDataRegistry.createWithCoreProviders();
        ConformanceTestProviders.BriefingTemplate.registerTypes(withBriefing);

        assertRejects(withoutBriefing);
        assertAccepts(withBriefing);
    }
}
