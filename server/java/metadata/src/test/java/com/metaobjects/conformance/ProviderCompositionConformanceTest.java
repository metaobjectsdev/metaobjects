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
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.template.MetaTemplate;
import com.metaobjects.template.TemplateConstants;
import org.junit.Test;
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
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
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
 */
@RunWith(Parameterized.class)
public class ProviderCompositionConformanceTest {

    private static final String CONFLICT_SUBTYPE = "compositionprobe";
    private static final String CONFLICT_ATTR = "conflictAttr";

    // ------------------------------------------------------------------
    // Probe MetaData classes for the attr-conflict / seal scenarios.
    // attr-conflict-base + attr-conflict-clash MUST share one implementation
    // class — extendType() looks the registered type up by class.
    // ------------------------------------------------------------------

    public static final class CompositionProbeTemplate extends MetaTemplate {
        public CompositionProbeTemplate(String name) { super(CONFLICT_SUBTYPE, name); }
    }

    public static final class SealProbeTemplate extends MetaTemplate {
        public SealProbeTemplate(String name) { super("sealprobe", name); }
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

    private static MetaDataTypeProvider resolve(String id) {
        MetaDataTypeProvider p = ConformanceTestProviders.TEST_PROVIDERS.get(id);
        if (p != null) return p;
        switch (id) {
            case "attr-conflict-base":  return ATTR_CONFLICT_BASE;
            case "attr-conflict-clash": return ATTR_CONFLICT_CLASH;
            case "seal-probe":          return SEAL_PROBE;
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

    private static String codeOf(MetaDataException ex) {
        return ex.getCode().map(Enum::name).orElse(ErrorCode.ERR_UNKNOWN.name());
    }
}
