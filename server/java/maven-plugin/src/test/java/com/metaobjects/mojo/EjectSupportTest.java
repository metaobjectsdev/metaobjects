package com.metaobjects.mojo;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * {@link EjectSupport} is the Maven-free engine behind {@code mvn metaobjects:eject} /
 * {@code -Dlist} — these tests exercise it directly (no Mojo, no MavenProject) so the
 * resolve / rewrite / compare logic is pinned independent of the Maven harness.
 */
public class EjectSupportTest {

    // ------------------------------------------------------------------------------------
    // catalog shape
    // ------------------------------------------------------------------------------------

    @Test
    public void everyEntryHasAPortAndAStableName() {
        List<EjectSupport.Entry> all = EjectSupport.allEntries();
        assertFalse(all.isEmpty());
        for (EjectSupport.Entry e : all) {
            assertNotNull(e.port);
            assertNotNull(e.stableName);
            assertNotNull(e.classname);
        }
    }

    @Test
    public void javasFusedExtractorGenericTemplateAndEntangledEntityAreRegisteredButNotEjectable() {
        List<EjectSupport.Entry> all = EjectSupport.allEntries();
        boolean sawJavaExtractor = false, sawJavaTemplate = false, sawJavaEntity = false;
        for (EjectSupport.Entry e : all) {
            if (e.port == EjectSupport.Port.JAVA && e.stableName.equals("extractor")) {
                sawJavaExtractor = true;
                assertNull("extractor is fused into entity — not ejectable on Java", e.resourcePath);
            }
            if (e.port == EjectSupport.Port.JAVA && e.stableName.equals("template")) {
                sawJavaTemplate = true;
                assertNull("template is a generic declarative primitive — not ejectable", e.resourcePath);
            }
            if (e.port == EjectSupport.Port.JAVA && e.stableName.equals("entity")) {
                sawJavaEntity = true;
                assertNull("entity lives in codegen-base and is entangled with the fused "
                        + "extractor plus a same-package writer hierarchy — not ejectable on Java",
                        e.resourcePath);
            }
        }
        assertTrue(sawJavaExtractor);
        assertTrue(sawJavaTemplate);
        assertTrue(sawJavaEntity);
    }

    @Test
    public void kotlinsEntityIsEjectableAndUnambiguousSinceJavasIsNot() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        assertEquals(1, catalog.get("entity").size());
        EjectSupport.Resolution r = EjectSupport.resolve("entity", catalog, null, null);
        assertTrue(r.ok());
        assertEquals(EjectSupport.Port.KOTLIN, r.entry.port);
    }

    @Test
    public void kotlinsExtractorIsEjectable() {
        List<EjectSupport.Entry> all = EjectSupport.allEntries();
        boolean found = all.stream().anyMatch(e ->
                e.port == EjectSupport.Port.KOTLIN && e.stableName.equals("extractor")
                        && e.resourcePath != null);
        assertTrue("Kotlin's extractor is a standalone generator, unlike Java's fused one", found);
    }

    @Test
    public void ejectableNamesUniqueToOnePortResolveWithoutAPort() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();

        EjectSupport.Resolution dto = EjectSupport.resolve("dto", catalog, null, null);
        assertTrue(dto.ok());
        assertEquals(EjectSupport.Port.JAVA, dto.entry.port);

        EjectSupport.Resolution exposedTable = EjectSupport.resolve("exposed-table", catalog, null, null);
        assertTrue(exposedTable.ok());
        assertEquals(EjectSupport.Port.KOTLIN, exposedTable.entry.port);
    }

    @Test
    public void aNameEjectableOnBothPortsRequiresDisambiguation() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        assertEquals(2, catalog.get("names").size());

        EjectSupport.Resolution noHint = EjectSupport.resolve("names", catalog, null, null);
        assertFalse(noHint.ok());
        assertTrue(noHint.error.contains("-Dport"));
    }

    @Test
    public void anExplicitPortWinsOverInference() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        EjectSupport.Resolution r = EjectSupport.resolve(
                "names", catalog, EjectSupport.Port.KOTLIN, EjectSupport.Port.JAVA);
        assertTrue(r.ok());
        assertEquals(EjectSupport.Port.KOTLIN, r.entry.port);
    }

    @Test
    public void anInferredPortResolvesAnAmbiguousNameWithNoExplicitFlag() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        EjectSupport.Resolution r = EjectSupport.resolve(
                "names", catalog, null, EjectSupport.Port.JAVA);
        assertTrue(r.ok());
        assertEquals(EjectSupport.Port.JAVA, r.entry.port);
    }

    @Test
    public void anUnknownNameFailsWithTheKnownList() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        EjectSupport.Resolution r = EjectSupport.resolve("no-such-generator", catalog, null, null);
        assertFalse(r.ok());
        assertTrue(r.error.contains("unknown"));
    }

    // ------------------------------------------------------------------------------------
    // port inference
    // ------------------------------------------------------------------------------------

    @Test
    public void inferPortReadsTheDeclaredCodegenDependency() {
        assertEquals(EjectSupport.Port.JAVA,
                EjectSupport.inferPort(List.of("metaobjects-codegen-spring")));
        assertEquals(EjectSupport.Port.KOTLIN,
                EjectSupport.inferPort(List.of("metaobjects-codegen-kotlin")));
        assertNull("neither declared — no inference",
                EjectSupport.inferPort(List.of("some-other-dep")));
        assertNull("both declared — ambiguous, no inference",
                EjectSupport.inferPort(List.of("metaobjects-codegen-spring", "metaobjects-codegen-kotlin")));
    }

    // ------------------------------------------------------------------------------------
    // package rewrite — the ONE edit a copy gets
    // ------------------------------------------------------------------------------------

    @Test
    public void rewritesTheJavaPackageLinePreservingTheSemicolon() {
        String src = "package com.metaobjects.generator.spring;\n\nimport java.util.List;\n\npublic class Foo {}\n";
        String out = EjectSupport.rewritePackage(src, "com.acme.codegen");
        assertTrue(out.startsWith("package com.acme.codegen;\n"));
        assertTrue(out.contains("import java.util.List;"));
        assertFalse(out.contains("com.metaobjects.generator.spring"));
    }

    @Test
    public void rewritesTheKotlinPackageLineWithNoSemicolon() {
        String src = "package com.metaobjects.generator.kotlin\n\nimport com.metaobjects.MetaData\n\nobject Foo\n";
        String out = EjectSupport.rewritePackage(src, "com.acme.codegen");
        assertTrue(out.startsWith("package com.acme.codegen\n"));
        assertFalse(out.contains(";"));
    }

    @Test(expected = IllegalStateException.class)
    public void rewritePackageRejectsSourceWithNoPackageLine() {
        EjectSupport.rewritePackage("class Foo {}", "com.acme.codegen");
    }

    // ------------------------------------------------------------------------------------
    // owned-copy comparison
    // ------------------------------------------------------------------------------------

    @Test
    public void anUnchangedCopyComparesIdenticalDespiteThePackageRename() {
        String reference = "package com.metaobjects.generator.spring;\n\npublic class Foo {\n    int x;\n}\n";
        String owned = "package com.acme.codegen;\n\npublic class Foo {\n    int x;\n}\n";
        EjectSupport.Comparison cmp = EjectSupport.compare(owned, reference);
        assertEquals(EjectSupport.Verdict.IDENTICAL, cmp.verdict);
        assertEquals(0, cmp.behind);
        assertEquals(0, cmp.ownedOnly);
    }

    @Test
    public void anEditedCopyReportsWhatChangedInEachDirection() {
        String reference = "package p;\n\npublic class Foo {\n    int x;\n    int y;\n}\n";
        String owned = "package p;\n\npublic class Foo {\n    int x;\n    int z;\n}\n";
        EjectSupport.Comparison cmp = EjectSupport.compare(owned, reference);
        assertEquals(EjectSupport.Verdict.DIFFERS, cmp.verdict);
        assertEquals(1, cmp.behind);     // "int y;" — the reference has it, the copy doesn't
        assertEquals(1, cmp.ownedOnly);  // "int z;" — the copy's own edit
    }

    // --- helper runtime ----------------------------------------------------------------

    private static final String GEN = "package com.metaobjects.generator.spring;\n\n"
            + "public class G {\n"
            + "    public static final String RUNTIME_PACKAGE = \"com.metaobjects.generator.spring.runtime\";\n"
            + "}\n";

    @Test
    public void rewriteRuntimePackageRewritesOnlyTheDeclaration() {
        String out = EjectSupport.rewriteRuntimePackage(GEN, "com.acme.runtime");
        assertTrue(out.contains("RUNTIME_PACKAGE = \"com.acme.runtime\";"));
        assertEquals(GEN.replace("com.metaobjects.generator.spring.runtime", "com.acme.runtime"), out);
        String none = "package p;\nclass X {}\n";
        assertEquals(none, EjectSupport.rewriteRuntimePackage(none, "com.acme.runtime"));
    }

    @Test
    public void eachEjectEditIsNotDrift() {
        String owned = EjectSupport.rewriteRuntimePackage(
                EjectSupport.rewritePackage(GEN, "com.acme.codegen"), "com.acme.runtime");
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(owned, GEN).verdict);

        String ref = "package com.metaobjects.generator.spring.runtime;\n\npublic final class R {}\n";
        String ownedRuntime = EjectSupport.ownedRuntimeSource(ref, "R", "com.acme.runtime");
        assertTrue(EjectSupport.isOwnedRuntime(ownedRuntime));
        assertFalse(EjectSupport.isOwnedRuntime(ref));
        assertTrue(ownedRuntime.contains("\npackage com.acme.runtime;\n"));
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(ownedRuntime, ref).verdict);
    }

    @Test
    public void onlyTheJavaWebTierCarriesRuntime() {
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            boolean expected = e.port == EjectSupport.Port.JAVA
                    && List.of("routes", "dto", "repository").contains(e.stableName);
            assertEquals(e.port.id + " " + e.stableName, expected, !e.runtime.isEmpty());
        }
    }
}
