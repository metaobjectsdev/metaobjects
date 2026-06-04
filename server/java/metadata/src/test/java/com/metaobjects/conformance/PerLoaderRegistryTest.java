package com.metaobjects.conformance;

import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.MetaDataRegistry;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertTrue;

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

    private static MetaDataLoader load(MetaDataLoader loader) {
        loader.load(List.<MetaDataSource>of(new InMemoryStringSource(META, "meta.t.json")));
        return loader;
    }

    /** Registry WITH briefing -> load succeeds with NO recorded errors. */
    private static void assertAccepts(MetaDataRegistry reg) {
        MetaDataLoader loader = load(newLoader("with-briefing", reg));
        assertTrue("expected a clean load (no recorded errors) when template.briefing "
                + "IS registered, got: " + loader.getErrors(),
            loader.getErrors().isEmpty());
    }

    /** Registry WITHOUT briefing -> load records ERR_UNKNOWN_SUBTYPE (template is a
     *  known type, briefing an unknown subtype). ADR-0022: an unknown child node is
     *  RECORDED + skipped (not thrown — only the root throws), mirroring the TS
     *  reference. The per-loader-registry isolation guarantee is asserted via the
     *  recorded code being specifically the template.briefing rejection. */
    private static void assertRejects(MetaDataRegistry reg) {
        MetaDataLoader loader = load(newLoader("without-briefing", reg));
        boolean rejected = loader.getErrors().stream().anyMatch(e -> {
            boolean unknownSubtype = e.getCode()
                .map(c -> c == com.metaobjects.ErrorCode.ERR_UNKNOWN_SUBTYPE
                       || c == com.metaobjects.ErrorCode.ERR_UNKNOWN_TYPE)
                .orElse(false);
            String m = String.valueOf(e.getMessage());
            // Tight: the failure must be specifically that template.briefing is an
            // unknown SUBTYPE — not merely any error (which would let unrelated
            // failures pass this guard).
            return unknownSubtype && (m.contains("template.briefing") || m.contains("template:briefing"));
        });
        assertTrue("expected a recorded template.briefing unknown-subtype failure, got: "
                + loader.getErrors(),
            rejected);
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
