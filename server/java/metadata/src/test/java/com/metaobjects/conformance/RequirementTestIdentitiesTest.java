package com.metaobjects.conformance;

import com.metaobjects.loader.DirectorySource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.requirement.MetaRequirement;
import com.metaobjects.requirement.RequirementCheck;
import com.metaobjects.requirement.RequirementTestIdentities;
import com.metaobjects.requirement.RequirementTestIdentities.Grain;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * What {@link RequirementTestIdentityConformanceTest} cannot say per case: facts about the corpus
 * as a whole, and the direct tests of what the corpus cannot hold. A plain class, so each runs
 * once rather than once per parameter.
 */
public class RequirementTestIdentitiesTest {

    /** The case count at the time of writing. A corpus that is empty or mislocated gives zero
     *  parameters to the parameterized runner, which is a green run; this is the floor under it. */
    private static final int CORPUS_CASE_FLOOR = 26;

    @Test
    public void theCorpusHasAtLeastTheCasesItHadAndTheRunnerRunsEveryOne() throws IOException {
        List<String> cases = RequirementTestIdentityConformanceTest.caseNames();
        assertTrue("found " + cases.size() + " case(s) in " + RequirementTestIdentityConformanceTest.CORPUS,
            cases.size() >= CORPUS_CASE_FLOOR);
        assertEquals(cases.size(), RequirementTestIdentityConformanceTest.fixtures().size());
    }

    @Test
    public void everyCaseOnDiskIsDocumentedInTheReadmeAndNothingElseIs() throws IOException {
        String readme = Files.readString(RequirementTestIdentityConformanceTest.CORPUS.resolve("README.md"), StandardCharsets.UTF_8);
        String section = readme.substring(readme.indexOf("\n## Cases\n"));
        int next = section.indexOf("\n## ", 1);
        if (next > 0) section = section.substring(0, next);
        List<String> documented = new ArrayList<>();
        Matcher m = RequirementTestIdentityConformanceTest.DOCUMENTED_CASE.matcher(section);
        while (m.find()) documented.add(m.group(1));
        documented.sort(Comparator.naturalOrder());
        assertEquals(RequirementTestIdentityConformanceTest.caseNames(), documented);
    }

    @Test
    public void filterTableHoldsExactlyTheEightNamedPredicates() {
        assertEquals(List.of("all", "architectural", "claims-entity", "level-5", "live",
            "package-acme-shop", "path-under-Shop", "unlevelled"),
            RequirementTestIdentityConformanceTest.FILTERS.keySet().stream().sorted().toList());
    }

    /** The corpus cannot hold a non-ASCII name (the loaders are not known to agree on one), so
     *  the key function is pinned directly. {@code Character.isLetterOrDigit} would keep the
     *  accents and give {@code req_acme_shop_Café_Réglé}. */
    @Test
    public void witnessKeyReplacesLettersOutsideAscii() {
        assertEquals("req_acme_shop_Caf_R_gl_",
            RequirementTestIdentities.witnessKeyOf("acme::shop::Café.Réglé", "*"));
    }

    @Test
    public void witnessKeyKeepsNoUnderscoreAndAddsUnitSuffix() {
        assertEquals("req_acme_shop_Sales_Orders__object_entity",
            RequirementTestIdentities.witnessKeyOf("acme::shop::Sales__Orders", "object.entity"));
        assertEquals("req_Orders_Recorded", RequirementTestIdentities.witnessKeyOf("Orders.Recorded", "*"));
    }

    @Test
    public void anUnknownGrainIsRefusedWithAClearError() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Grain.parse("hybrid"));
        assertTrue(e.getMessage(), e.getMessage().contains("\"hybrid\""));
        assertTrue(e.getMessage(), e.getMessage().contains("\"concern\" or \"member\""));
        assertEquals(Grain.CONCERN, Grain.parse("concern"));
        assertEquals(Grain.MEMBER, Grain.parse("member"));
    }

    /**
     * What the loader reports for a requirement that declares its own package: the effective-package
     * rule in {@code RequirementCheck.effectivePackage} reads {@code getPackage()} up the parent
     * chain, so the declaring node itself must report it (and the walk then gives a nested child
     * that declares none its parent's package, not its file's).
     */
    @Test
    public void aNestedRequirementThatDeclaresItsOwnPackageReportsItFromGetPackage() throws IOException {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "requirement_test_identity_probe");
        loader.init();
        loader.load(new DirectorySource(RequirementTestIdentityConformanceTest.CORPUS.resolve("filter-by-package").resolve("input"),
            new DirectorySource.Options()).expandToList());
        assertTrue(loader.getErrors().toString(), loader.getErrors().isEmpty());
        Map<String, MetaRequirement> byPath = new HashMap<>();
        for (RequirementCheck.Addressed a : RequirementCheck.collectAddressed(loader.getRoot())) byPath.put(a.path(), a.node());

        assertEquals("acme::shop", byPath.get("Settled").getPackage());
        assertEquals("acme::billing", byPath.get("Invoiced").getPackage());
        assertEquals("acme::shop", RequirementCheck.effectivePackage(byPath.get("Settled.Timed")));
        assertEquals("acme::billing", RequirementCheck.effectivePackage(byPath.get("Invoiced.Numbered")));
        assertEquals("acme::billing", RequirementCheck.effectivePackage(byPath.get("Billed")));
    }
}
