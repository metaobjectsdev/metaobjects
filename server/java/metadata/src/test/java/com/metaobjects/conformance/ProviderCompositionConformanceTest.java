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
package com.metaobjects.conformance;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.attr.IntAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.RegistryManifest;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;
import com.metaobjects.view.CurrencyView;
import org.junit.Test;
import org.junit.experimental.runners.Enclosed;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

/**
 * Provider-composition conformance runner (JVM port — Java + Kotlin share this
 * registry).
 *
 * <p>Five registry/provider error codes are Tier-1 cross-port invariants that
 * the metadata-input → error corpus cannot reach: they are triggered by HOW
 * providers are composed and sealed, not by any metadata document. This runner
 * gates them from the shared corpus at
 * {@code fixtures/provider-composition-conformance/}.</p>
 *
 * <p>Each port supplies the SAME canonical named-provider set (see the corpus
 * README). A manifest names providers by id; the runner maps names → provider
 * objects, composes, and asserts the surfaced code. The registry-sealed
 * scenario composes, seals, then runs a probe provider's {@code registerTypes}
 * against the sealed registry.</p>
 *
 * <p>#265 adds a SECOND, differently-shaped corpus at {@code compose-load/}
 * (see the corpus README "The {@code compose-load/} subdir") that composes the
 * library's real core provider set with a consumer provider and, for some
 * scenarios, strict-loads an actual metadata document. JUnit4's
 * {@link Parameterized} runner supports exactly one {@code @Parameters} source
 * per class, so the two corpora are split into sibling {@code public static}
 * classes under this class's {@link Enclosed} runner — mirroring the
 * TS/Python/C# runners' two independent test loops in one file. {@link Enclosed}
 * sweeps every PUBLIC nested class into its suite (see {@code getClasses()}),
 * so the probe/provider helper classes below are deliberately package-private,
 * not {@code public} — only {@link FlatCorpus} and {@link ComposeLoad} (both
 * genuinely {@code @RunWith(Parameterized.class)}) are public.</p>
 */
@RunWith(Enclosed.class)
public class ProviderCompositionConformanceTest {

    private static final String CONFLICT_SUBTYPE = "compositionprobe";
    private static final String CONFLICT_ATTR = "conflictAttr";

    // ------------------------------------------------------------------
    // Probe MetaData classes for the attr-conflict / seal scenarios.
    // attr-conflict-base + attr-conflict-clash MUST share one implementation
    // class — extendType() looks the registered type up by class.
    //
    // Package-private (NOT public): Enclosed sweeps every PUBLIC member class
    // of the outer class into its suite via Class#getClasses(), which would
    // try (and fail) to run these as standalone JUnit test classes.
    // ------------------------------------------------------------------

    static final class CompositionProbeTemplate extends MetaTemplate {
        CompositionProbeTemplate(String name) { super(CONFLICT_SUBTYPE, name); }
    }

    static final class SealProbeTemplate extends MetaTemplate {
        SealProbeTemplate(String name) { super("sealprobe", name); }
    }

    // ------------------------------------------------------------------
    // Canonical named-provider set (test-only; identical id/deps/behavior
    // cross-port). The no-op cycle/duplicate/missing providers are reused from
    // ConformanceTestProviders.TEST_PROVIDERS.
    // ------------------------------------------------------------------

    /** Registers a fresh test-only type carrying a single REQUIRED conflictAttr. */
    private static final MetaDataTypeProvider ATTR_CONFLICT_BASE = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "attr-conflict-base"; }
        @Override public String[] getDependencies() { return new String[0]; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            registry.registerType(CompositionProbeTemplate.class, def -> {
                def.type(TemplateConstants.TYPE_TEMPLATE).subType(CONFLICT_SUBTYPE)
                   .description("Test-only — provider-composition conflict probe.")
                   .inheritsFrom(TemplateConstants.TYPE_TEMPLATE, TemplateConstants.SUBTYPE_BASE);
                def.requiredAttributeWithConstraints(CONFLICT_ATTR)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            });
        }
        @Override public String getDescription() { return "Test-only attr-conflict base provider."; }
    };

    /** Extends the base's type, redeclaring conflictAttr (optional) — attr conflict. */
    private static final MetaDataTypeProvider ATTR_CONFLICT_CLASH = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "attr-conflict-clash"; }
        @Override public String[] getDependencies() { return new String[]{"attr-conflict-base"}; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            registry.extendType(CompositionProbeTemplate.class, def ->
                def.optionalAttributeWithConstraints(CONFLICT_ATTR)
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle());
        }
        @Override public String getDescription() { return "Test-only attr-conflict clash provider."; }
    };

    /** Attempts a mutating registration — throws against a sealed registry. */
    private static final MetaDataTypeProvider SEAL_PROBE = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "seal-probe"; }
        @Override public String[] getDependencies() { return new String[0]; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            registry.registerType(SealProbeTemplate.class, def ->
                def.type(TemplateConstants.TYPE_TEMPLATE).subType("sealprobe")
                   .description("Test-only — sealed-registry mutation probe.")
                   .inheritsFrom(TemplateConstants.TYPE_TEMPLATE, TemplateConstants.SUBTYPE_BASE));
        }
        @Override public String getDescription() { return "Test-only seal probe provider."; }
    };

    /**
     * #265 {@code compose-load/} canonical named provider. Extends
     * {@code view.currency} (a SPEC-DECLARED CORE subtype the library's own
     * core-types provider registers) with a new {@code decimals} int attr.
     * Deliberately NO dependencies — see the corpus README "Canonical named
     * provider {@code extend-spec-subtype}" for why (cross-port id/dep parity
     * vs. the {@code composeWithCore} ordering contract).
     */
    private static final MetaDataTypeProvider EXTEND_SPEC_SUBTYPE = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "extend-spec-subtype"; }
        @Override public String[] getDependencies() { return new String[0]; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            registry.extendType(CurrencyView.class, def ->
                def.optionalAttribute("decimals", IntAttribute.SUBTYPE_INT));
        }
        @Override public String getDescription() { return "Test-only — #265 compose-load probe: extends view.currency with @decimals."; }
    };

    private static MetaDataTypeProvider resolve(String id) {
        MetaDataTypeProvider p = ConformanceTestProviders.TEST_PROVIDERS.get(id);
        if (p != null) return p;
        switch (id) {
            case "attr-conflict-base":  return ATTR_CONFLICT_BASE;
            case "attr-conflict-clash": return ATTR_CONFLICT_CLASH;
            case "seal-probe":          return SEAL_PROBE;
            case "extend-spec-subtype": return EXTEND_SPEC_SUBTYPE;
            default:
                throw new IllegalArgumentException(
                    "Unknown named provider \"" + id + "\" in provider-composition corpus");
        }
    }

    // ------------------------------------------------------------------
    // Corpus discovery.
    // ------------------------------------------------------------------

    private static Path corpusRoot() {
        String env = System.getenv("METAOBJECTS_PROVIDER_COMPOSITION_CORPUS");
        if (env != null && !env.isEmpty()) {
            Path envPath = Paths.get(env);
            if (Files.isDirectory(envPath)) return envPath.toAbsolutePath();
        }
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures").resolve("provider-composition-conformance");
            if (Files.isDirectory(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError(
            "could not locate fixtures/provider-composition-conformance from "
                + Paths.get("").toAbsolutePath());
    }

    private static String codeOf(MetaDataException ex) {
        return ex.getCode().map(Enum::name).orElse(ErrorCode.ERR_UNKNOWN.name());
    }

    // ------------------------------------------------------------------
    // Flat corpus — error-code manifests ({description, providers[],
    // expectedError, sealThenRegister?}). Shape UNCHANGED.
    // ------------------------------------------------------------------

    @RunWith(Parameterized.class)
    public static class FlatCorpus {

        @Parameters(name = "{0}")
        public static Collection<Object[]> manifests() {
            try (Stream<Path> files = Files.list(corpusRoot())) {
                List<String> names = files
                    .filter(p -> p.getFileName().toString().endsWith(".json"))
                    .map(p -> p.getFileName().toString())
                    .sorted()
                    .collect(Collectors.toList());
                if (names.isEmpty()) {
                    throw new AssertionError("provider-composition corpus is empty (mis-pathed root?)");
                }
                List<Object[]> rows = new ArrayList<>(names.size());
                for (String n : names) rows.add(new Object[]{n});
                return rows;
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        @Parameter(0)
        public String fileName;

        @Test
        public void providerComposition() throws IOException {
            JsonObject manifest = JsonParser.parseString(
                Files.readString(corpusRoot().resolve(fileName))).getAsJsonObject();
            String expected = manifest.get("expectedError").getAsString();

            List<MetaDataTypeProvider> resolved = new ArrayList<>();
            manifest.getAsJsonArray("providers").forEach(e -> resolved.add(resolve(e.getAsString())));

            if (manifest.has("sealThenRegister")) {
                // Compose (must succeed), seal, then run the probe against the sealed registry.
                MetaDataRegistry registry = MetaDataRegistry.compose(resolved);
                registry.seal();
                MetaDataTypeProvider probe = resolve(manifest.get("sealThenRegister").getAsString());
                try {
                    probe.registerTypes(registry);
                    fail("expected " + expected + " but no exception was thrown");
                } catch (MetaDataException ex) {
                    assertEquals(expected, codeOf(ex));
                }
                return;
            }

            // Ordinary scenario: compose itself throws.
            try {
                MetaDataRegistry.compose(resolved);
                fail("expected " + expected + " but no exception was thrown");
            } catch (MetaDataException ex) {
                assertEquals(expected, codeOf(ex));
            }
        }
    }

    // ------------------------------------------------------------------
    // #265 compose-load corpus — see the corpus README "The `compose-load/`
    // subdir". Own directory, own nested runner: a manifest here never carries
    // `expectedError` / `sealThenRegister` (the flat-corpus shape above); it
    // carries `composeWithCore` / `expectAttrs` / `metadata` / `expectErrors`
    // instead.
    // ------------------------------------------------------------------

    @RunWith(Parameterized.class)
    public static class ComposeLoad {

        private static Path composeLoadCorpusRoot() {
            return corpusRoot().resolve("compose-load");
        }

        @Parameters(name = "{0}")
        public static Collection<Object[]> manifests() {
            try (Stream<Path> files = Files.list(composeLoadCorpusRoot())) {
                List<String> names = files
                    .filter(p -> p.getFileName().toString().endsWith(".json"))
                    .map(p -> p.getFileName().toString())
                    .sorted()
                    .collect(Collectors.toList());
                if (names.isEmpty()) {
                    throw new AssertionError("provider-composition compose-load corpus is empty (mis-pathed root?)");
                }
                List<Object[]> rows = new ArrayList<>(names.size());
                for (String n : names) rows.add(new Object[]{n});
                return rows;
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }

        @Parameter(0)
        public String fileName;

        @Test
        public void providerCompositionComposeLoad() throws IOException {
            JsonObject manifest = JsonParser.parseString(
                Files.readString(composeLoadCorpusRoot().resolve(fileName))).getAsJsonObject();

            List<MetaDataTypeProvider> named = new ArrayList<>();
            manifest.getAsJsonArray("providers").forEach(e -> named.add(resolve(e.getAsString())));
            boolean composeWithCore = manifest.has("composeWithCore")
                    && manifest.get("composeWithCore").getAsBoolean();

            // composeWithCore routes through RegistryManifest.composeMetamodelRegistry —
            // the MetaDataLoader.setTypeRegistry(...) seam adopters use — NOT the raw
            // MetaDataRegistry.compose(...) the flat corpus above exercises. This is the
            // path that must apply strict spec-description scoping to the consumer's
            // extension (#265).
            MetaDataRegistry registry = composeWithCore
                ? RegistryManifest.composeMetamodelRegistry(named)
                : MetaDataRegistry.compose(named);

            if (manifest.has("expectAttrs")) {
                JsonObject expectAttrs = manifest.getAsJsonObject("expectAttrs");
                String type = expectAttrs.get("type").getAsString();
                String subType = expectAttrs.get("subType").getAsString();
                expectAttrs.getAsJsonArray("contains").forEach(nameEl -> {
                    String name = nameEl.getAsString();
                    assertNotNull(
                        "expected (" + type + ", " + subType + ") to declare attr \"" + name + "\"",
                        registry.getChildRequirement(type, subType, name));
                });
            }

            if (manifest.has("metadata")) {
                String content = manifest.get("metadata").toString();
                // sanitizeRootName normalizes hyphens but not the ".json" suffix — strip
                // it ourselves so the loader name satisfies the identifier pattern.
                String loaderName = "composeLoad" + fileName.replaceFirst("\\.json$", "");
                MetaDataLoader loader = new MetaDataLoader(
                    LoaderOptions.create(false, false, true),
                    MetaDataLoader.SUBTYPE_MANUAL, loaderName);
                loader.setTypeRegistry(registry);
                loader.init();

                MetaDataException thrown = null;
                try {
                    loader.load(List.of(new InMemoryStringSource(
                        content, "<inline>", MetaDataSource.MetaDataFormat.JSON)));
                } catch (MetaDataException ex) {
                    thrown = ex;
                }
                List<MetaDataException> recordedErrors = loader.getErrors();
                List<String> actualCodes = new ArrayList<>();
                for (MetaDataException recorded : recordedErrors) {
                    actualCodes.add(codeOf(recorded));
                }
                // #265/#267 hardening: MetaDataException carries no equals()/hashCode()
                // override, so this List#contains is a reference-identity check — it
                // skips `thrown` only when it is the EXACT SAME exception instance a
                // validation phase already recorded via addError() (then eager-threw),
                // preventing a double count of one underlying failure. Two genuinely
                // distinct exceptions sharing the same .code (a future multi-error
                // fixture) are still both counted, matching the TS reference's sorted
                // full error-code list comparison.
                if (thrown != null && !recordedErrors.contains(thrown)) {
                    actualCodes.add(codeOf(thrown));
                }

                List<String> expectedCodes = new ArrayList<>();
                if (manifest.has("expectErrors")) {
                    manifest.getAsJsonArray("expectErrors").forEach(e -> expectedCodes.add(e.getAsString()));
                }
                Collections.sort(actualCodes);
                Collections.sort(expectedCodes);
                assertEquals(expectedCodes, actualCodes);
            }
        }
    }

    // ------------------------------------------------------------------
    // #265 regression — extendType()'s diff-stamp base must be existing's FULL
    // (direct + inherited) requirement set, not direct-only. Java-local (not a
    // shared cross-port fixture): the direct/inherited requirement split this
    // bug lives in is a Java-registry-specific concept — Python/C#/TS registries
    // are flat, with no separate "inherited" tier to flatten.
    //
    // Not corpus-driven (a single fixed scenario), so a plain JUnit4 class with
    // one @Test — Enclosed's default RunnerBuilder picks BlockJUnit4ClassRunner
    // for it automatically (no @RunWith needed).
    // ------------------------------------------------------------------

    public static class InheritedAttrProvenanceRegression {

        @Test
        public void extendingASubtypeDoesNotSpareItsInheritedOutOfScopeAttrs() {
            // extendType() rebuilds via TypeDefinitionBuilder.from(existing), which
            // seeds its flat builder map from existing.getChildRequirements() (direct
            // + inherited) — build() then writes that flat map into the REBUILT
            // definition's DIRECT requirements (inherited left empty). A provider
            // extending object.projection for a reason entirely UNRELATED to
            // @discriminator must not cause object.base's broadly-inherited
            // @discriminator (B2b scopes discriminator*/discriminatorValue to
            // object.entity ONLY — an FR-014 single-table-inheritance marker
            // meaningless on a derived, read-only projection) to be mis-stamped as
            // this provider's own and spared from strict scoping's prune.
            //
            // object.projection (unlike field.* / view.currency / object.value /
            // identity.secondary / index.lookup) is untouched by every library
            // register()/extendType()/applyProviderExtends pass — grep spec/metamodel/
            // {ui,prompt,db}.json's "extends" targets plus CoreDBMetaDataProvider's two
            // explicit extendType() calls: none touch object.projection. So, unlike
            // those, its inherited attrs are STILL genuinely inherited (not already
            // flattened + library-stamped by an earlier pass) at the moment this
            // provider's own extendType() runs — which is what actually exercises the
            // diff-base bug rather than incidentally masking it.
            MetaDataTypeProvider extendObjectProjection = new MetaDataTypeProvider() {
                @Override public String getProviderId() { return "extend-object-projection-unrelated"; }
                @Override public String[] getDependencies() { return new String[0]; }
                @Override public void registerTypes(MetaDataRegistry registry) {
                    registry.extendType(com.metaobjects.object.ProjectionMetaObject.class, def ->
                        def.optionalAttribute("unrelatedProbeAttr", StringAttribute.SUBTYPE_STRING));
                }
                @Override public String getDescription() {
                    return "Test-only — #265 regression probe: extends object.projection with an "
                        + "attr unrelated to @discriminator, to isolate the flatten-on-extend bug.";
                }
            };

            MetaDataRegistry registry = RegistryManifest.composeMetamodelRegistry(List.of(extendObjectProjection));

            // @discriminator is scoped to object.entity only (B2b) — object.projection
            // merely INHERITS it from object.base, and that inheritance must still be
            // pruned from the registry's declared-attr lookup even though an unrelated
            // provider extendType()'d object.projection. Pre-fix, the flatten-on-extend
            // bug mis-stamped @discriminator as the extending provider's own, so it
            // survived the prune (getChildRequirement returned non-null).
            assertNull(
                "expected (object, projection) to NOT declare @discriminator (B2b scopes it "
                    + "to object.entity only; object.projection only INHERITS it from object.base "
                    + "and that inheritance must still be pruned after an unrelated extendType())",
                registry.getChildRequirement("object", "projection", "discriminator"));

            // Sanity check: the unrelated attr this provider actually added is present —
            // proves the extendType() call itself succeeded and wasn't a no-op.
            assertNotNull(
                "expected (object, projection) to declare the provider's own unrelatedProbeAttr",
                registry.getChildRequirement("object", "projection", "unrelatedProbeAttr"));
        }
    }
}
