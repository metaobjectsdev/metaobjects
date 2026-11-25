package com.metaobjects.requirement;

import com.metaobjects.MetaDataException;
import com.metaobjects.MetaRoot;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.RegistryManifest;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The requirements ledger is its own pack ({@code metaobjects-requirements}). With the pack in
 * the default bundle the gate behaves as before; with it left out, a model with no requirement
 * nodes gets an empty, silent ledger and a model that declares one fails at load.
 */
public class RequirementsPackLeftOutTest {

    private static final String PLAIN = """
        {"metadata.root": {"package": "p", "children": [
          {"object.value": {"name": "Thing", "children": [{"field.string": {"name": "label"}}]}}
        ]}}
        """;

    private static final String WITH_REQUIREMENT = """
        {"metadata.root": {"package": "p", "children": [
          {"object.value": {"name": "Thing", "children": [{"field.string": {"name": "label"}}]}},
          {"requirement.functional": {"name": "labels", "@level": 4, "@status": "planned",
            "@statement": "A thing has a label.", "@counterexample": "A thing with no label."}}
        ]}}
        """;

    private static MetaDataLoader load(String json, boolean packIn) {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "p");
        if (!packIn) {
            loader.setTypeRegistry(RegistryManifest.composeLoaderRegistry(List.of(), List.of("requirement-types")));
        }
        loader.init();
        loader.load(List.of(new InMemoryStringSource(json, "meta.p.json")));
        return loader;
    }

    @Test
    public void defaultBundleLoadsAndCountsTheRequirement() {
        MetaRoot root = load(WITH_REQUIREMENT, true).getRoot();
        RequirementCheck.Scan scan = RequirementCheck.scan(root, new RequirementCheck.Options(null, false));
        assertEquals(1, scan.addressed().size());
    }

    @Test
    public void leftOutAModelWithNoRequirementsHasAnEmptySilentLedger() {
        MetaRoot root = load(PLAIN, false).getRoot();
        assertNotNull(root);
        RequirementCheck.Scan scan = RequirementCheck.scan(root, new RequirementCheck.Options(null, false));
        assertTrue(scan.addressed().isEmpty());
        assertTrue(RequirementCheck.check(root, scan).isEmpty());
    }

    @Test
    public void leftOutAModelThatDeclaresARequirementFailsAtLoad() {
        List<String> codes = new java.util.ArrayList<>();
        try {
            for (MetaDataException e : load(WITH_REQUIREMENT, false).getErrors()) {
                codes.add(e.getCode().map(Enum::name).orElse(""));
            }
        } catch (MetaDataException e) {
            codes.add(e.getCode().map(Enum::name).orElse(""));
        }
        assertTrue(codes.toString(), codes.contains("ERR_UNKNOWN_TYPE") || codes.contains("ERR_UNKNOWN_SUBTYPE"));
    }
}
