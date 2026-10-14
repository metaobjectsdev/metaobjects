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
    public void entityAndExtractorAreEjectableOnBothPortsAndSoNeedAPort() {
        Map<String, List<EjectSupport.Entry>> catalog = EjectSupport.ejectableByStableName();
        for (String name : List.of("entity", "extractor")) {
            assertEquals(name, 2, catalog.get(name).size());
            EjectSupport.Resolution noHint = EjectSupport.resolve(name, catalog, null, null);
            assertFalse(name, noHint.ok());
            assertTrue(noHint.error, noHint.error.contains("-Dport"));

            EjectSupport.Resolution java = EjectSupport.resolve(name, catalog, EjectSupport.Port.JAVA, null);
            assertTrue(name, java.ok());
            assertEquals(EjectSupport.Port.JAVA, java.entry.port);
            assertTrue(java.entry.classname,
                    java.entry.classname.startsWith("com.metaobjects.generator.direct.object.javacode."));

            EjectSupport.Resolution kotlin = EjectSupport.resolve(name, catalog, EjectSupport.Port.KOTLIN, null);
            assertTrue(name, kotlin.ok());
            assertEquals(EjectSupport.Port.KOTLIN, kotlin.entry.port);
        }
    }

    @Test
    public void theJavaExtractorAndApiDocsOnBothPortsCarryAWiringNoteAndItNamesTheOwnedClass() {
        int noted = 0;
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            boolean javaExtractor = e.port == EjectSupport.Port.JAVA && e.stableName.equals("extractor");
            boolean apiDocs = e.stableName.equals("api-docs");
            String note = e.wiringNote("com.acme.codegen");
            if (!javaExtractor && !apiDocs) {
                assertNull(e.port.id + " " + e.stableName, note);
                continue;
            }
            noted++;
            String ownedPackage = apiDocs ? "com.acme.codegen.apidocs." + e.port.id : "com.acme.codegen";
            assertTrue(note, note.contains("<classname>" + ownedPackage + "." + e.simpleName() + "</classname>"));
            assertFalse(note, note.contains("{owned}"));
            // The goal that runs it is the one that runs every generator, on either port.
            if (apiDocs) assertTrue(note, note.contains("`mvn metaobjects:generate` runs this generator"));
        }
        assertEquals("the Java extractor, and api-docs on each port", 3, noted);
    }

    @Test
    public void onlyTheApiDocsCopiesTakeASubpackageAndEachPortHasItsOwn() {
        // The two ports' api reference classes share simple names, and one module may own both.
        // Every other generator keeps the package it ejected into before 1.1.
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            String expected = e.stableName.equals("api-docs")
                    ? "com.acme.codegen.apidocs." + e.port.id : "com.acme.codegen";
            assertEquals(e.port.id + " " + e.stableName, expected, e.ownedPackage("com.acme.codegen"));
        }
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

    /**
     * ADR-0034 Amendment 6: an owned generator extends and calls the classes copied with it,
     * never the packaged ones. So an import of a copied class follows the copy, and an
     * import of anything else (here the file writer, which is engine, and a class whose name
     * merely starts like a copied one) stays.
     */
    @Test
    public void anImportOfAClassCopiedAlongFollowsTheCopyAndNoOtherImportMoves() {
        EjectSupport.Entry entity = EjectSupport.resolve(
                "entity", EjectSupport.ejectableByStableName(), EjectSupport.Port.JAVA, null).entry;
        String src = "package com.metaobjects.generator.direct.object.javacode;\n\n"
                + "import com.metaobjects.generator.direct.object.BaseObjectCodeWriter;\n"
                + "import com.metaobjects.generator.direct.object.BaseObjectCodeWriterFactory;\n"
                + "import com.metaobjects.generator.util.GeneratedFileWriter;\n"
                + "import com.metaobjects.generator.direct.GenerationContext;\n\n"
                + "public class Foo extends BaseObjectCodeWriter {}\n";

        assertEquals("package com.metaobjects.generator.direct.object.javacode;\n\n"
                + "import com.acme.codegen.BaseObjectCodeWriter;\n"
                + "import com.metaobjects.generator.direct.object.BaseObjectCodeWriterFactory;\n"
                + "import com.metaobjects.generator.util.GeneratedFileWriter;\n"
                + "import com.metaobjects.generator.direct.GenerationContext;\n\n"
                + "public class Foo extends BaseObjectCodeWriter {}\n",
                EjectSupport.rewriteCopiedImports(src, entity.sources(), "com.acme.codegen"));
        assertTrue(EjectSupport.ownedSource(entity, src, "com.acme.codegen")
                .startsWith("package com.acme.codegen;\n"));
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
    public void supportImportsMoveToTheOwnedPackageAndAreNotDrift() {
        String gen = "package com.metaobjects.generator.spring;\n\n"
                + "import com.metaobjects.generator.spring.SpringGeneratorSupport;\n"
                + "import com.metaobjects.generator.spring.SpringNaming;\n\n"
                + "public class G {}\n";
        assertEquals(List.of("SpringGeneratorSupport"), EjectSupport.supportFor(gen));
        String owned = EjectSupport.rewriteSupportImports(gen, "com.acme.codegen");
        assertEquals("package com.metaobjects.generator.spring;\n\n"
                + "import com.acme.codegen.SpringGeneratorSupport;\n"
                + "import com.metaobjects.generator.spring.SpringNaming;\n\n"
                + "public class G {}\n", owned);
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(
                EjectSupport.rewritePackage(owned, "com.acme.codegen"), gen).verdict);
        // The owned copy no longer imports a packaged support class: nothing more to hand over.
        assertEquals(List.of(), EjectSupport.supportFor(owned));

        String none = "package p;\nimport java.util.List;\nclass X {}\n";
        assertEquals(List.of(), EjectSupport.supportFor(none));
        assertEquals(none, EjectSupport.rewriteSupportImports(none, "com.acme.codegen"));

        String ref = "package com.metaobjects.generator.spring;\n\npublic final class SpringGeneratorSupport {}\n";
        String ownedSupport = EjectSupport.ownedSupportSource(ref, "SpringGeneratorSupport", "com.acme.codegen");
        assertTrue(EjectSupport.isOwnedSupport(ownedSupport));
        assertFalse(EjectSupport.isOwnedSupport(ref));
        assertFalse(EjectSupport.isOwnedRuntime(ownedSupport));
        assertTrue(ownedSupport.contains("\npackage com.acme.codegen;\n"));
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(ownedSupport, ref).verdict);
        assertEquals(EjectSupport.Verdict.DIFFERS,
                EjectSupport.compare(ownedSupport + "// mine\n", ref).verdict);
    }

    @Test
    public void onlyTheJavaWebTierCarriesRuntime() {
        for (EjectSupport.Entry e : EjectSupport.allEntries()) {
            boolean expected = e.port == EjectSupport.Port.JAVA
                    && List.of("routes", "dto", "repository").contains(e.stableName);
            assertEquals(e.port.id + " " + e.stableName, expected, !e.runtime.isEmpty());
        }
    }

    // ------------------------------------------------------------------------------------
    // Kotlin imports, template prefix, and the ownership comparison across copies
    // ------------------------------------------------------------------------------------

    @Test
    public void aKotlinImportOfAClassCopiedAlongFollowsTheCopyWithoutGainingASemicolon() {
        String src = "package com.metaobjects.generator.kotlin\n\n"
                + "import com.metaobjects.generator.kotlin.KotlinEnumEmitter\n"
                + "import com.metaobjects.generator.kotlin.KotlinEnumEmitterFactory\n"
                + "import com.metaobjects.generator.kotlin.KotlinNaming\n\n"
                + "class Foo\n";
        assertEquals("package com.metaobjects.generator.kotlin\n\n"
                + "import com.acme.codegen.KotlinEnumEmitter\n"
                + "import com.metaobjects.generator.kotlin.KotlinEnumEmitterFactory\n"
                + "import com.metaobjects.generator.kotlin.KotlinNaming\n\n"
                + "class Foo\n",
                EjectSupport.rewriteCopiedImports(src,
                        List.of("com.metaobjects.generator.kotlin.KotlinEnumEmitter"), "com.acme.codegen"));
    }

    @Test
    public void everyKotlinEntryResolvesItsCopiedClassesToKotlinSources() {
        EjectSupport.Entry entity = EjectSupport.resolve(
                "entity", EjectSupport.ejectableByStableName(), EjectSupport.Port.KOTLIN, null).entry;
        assertEquals(List.of("com.metaobjects.generator.kotlin.KotlinEntityGenerator",
                "com.metaobjects.generator.kotlin.KotlinEnumEmitter"), entity.sources());
        assertTrue(entity.resourceOf("com.metaobjects.generator.kotlin.KotlinEnumEmitter"),
                entity.resourceOf("com.metaobjects.generator.kotlin.KotlinEnumEmitter")
                        .endsWith("/kotlin/KotlinEnumEmitter.kt"));
    }

    @Test
    public void aCopiedTemplateProviderIsPointedAtTheOwnedPackagesTemplates() {
        String src = "package com.metaobjects.generator.apidocs;\n\npublic final class P {\n"
                + "    private static final String BASE_PREFIX = \"templates/\";\n}\n";
        assertEquals("com/acme/codegen/templates/", EjectSupport.ownedTemplatePrefix("com.acme.codegen"));
        String owned = EjectSupport.rewriteTemplatePrefix(src, "com.acme.codegen");
        assertTrue(owned, owned.contains("BASE_PREFIX = \"com/acme/codegen/templates/\";"));
        // A source with no such declaration is returned as it came.
        assertEquals("class X {}\n", EjectSupport.rewriteTemplatePrefix("class X {}\n", "com.acme.codegen"));
        // The rewritten line is eject's own edit, so the copy still compares identical.
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(
                EjectSupport.rewritePackage(owned, "com.acme.codegen"), src).verdict);
    }

    @Test
    public void aFileTwoGeneratorsCopyComparesIdenticalWhicheverOneWroteIt() {
        // The extractor is copied with entity, which points its import of the entity's base at the
        // owned copy, and on its own, which leaves that import on the engine. Either way it is the
        // reference: the import is eject's own edit.
        String ref = "package com.metaobjects.generator.direct.object.javacode;\n\n"
                + "import com.metaobjects.generator.direct.object.BaseObjectCodeGenerator;\n"
                + "import com.metaobjects.generator.util.GeneratorUtil;\n\npublic class E {}\n";
        String viaEntity = ref.replace("com.metaobjects.generator.direct.object.BaseObjectCodeGenerator",
                "com.acme.codegen.BaseObjectCodeGenerator")
                .replace("package com.metaobjects.generator.direct.object.javacode;", "package com.acme.codegen;");
        assertEquals(EjectSupport.Verdict.IDENTICAL, EjectSupport.compare(viaEntity, ref).verdict);
        // An import of anything else is still compared.
        assertEquals(EjectSupport.Verdict.DIFFERS,
                EjectSupport.compare(viaEntity.replace("GeneratorUtil", "OtherUtil"), ref).verdict);
    }
}
