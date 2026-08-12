package com.metaobjects.conformance;

import com.metaobjects.registry.MetaDataTypeProvider;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.Assert.assertTrue;

/**
 * Gates the logical-to-physical provider mapping.
 *
 * <p>Conformance fixtures name LOGICAL provider ids. TypeScript, C# and Python map those
 * 1:1 onto their own providers; Java splits one logical id across many SPI providers, so
 * it needs an explicit map. That asymmetry is deliberate — physical packaging is idiomatic
 * per ecosystem, and {@code expected-registry.json} is provider-blind by design (ADR-0050),
 * so no byte-gate can see it.</p>
 *
 * <p><b>Why this test exists.</b> The map silently omitted three shipped core providers
 * ({@code index-types}, {@code origin-types}, {@code requirement-types} — the last being a
 * brand-new type family) and nothing failed, because {@code ConformanceTest} composes the
 * full ServiceLoader superset rather than each fixture's declared set. The mapping was both
 * incomplete and unexercised, which is how a mapping rots: nothing reads it closely enough
 * to notice.</p>
 *
 * <p>A provider is exempt only if it is genuinely outside the metamodel vocabulary the
 * corpus describes (codegen extensions, the object-manager runtime). Those are listed
 * explicitly, so adding one is a deliberate act rather than an omission.</p>
 */
public class ProviderAliasCompletenessTest {

    /**
     * Providers that ship on the classpath but are NOT part of the cross-port metamodel
     * vocabulary — runtime/codegen concerns the conformance corpus does not describe.
     */
    private static final Set<String> NOT_METAMODEL_VOCABULARY = Set.of(
        "codegen-extensions",       // codegen-base: generator-side extensions
        "om-managed-types",         // object-manager runtime
        "core-object-extensions"    // object-manager's object extensions
    );

    @Test
    public void everyShippedProviderIsClaimedByALogicalId() {
        Set<String> mapped = new TreeSet<>();
        for (List<String> physical : ConformanceTest.providerAliases().values()) {
            mapped.addAll(physical);
        }

        List<String> unclaimed = new ArrayList<>();
        for (MetaDataTypeProvider p : ServiceLoader.load(MetaDataTypeProvider.class)) {
            String id = p.getProviderId();
            if (NOT_METAMODEL_VOCABULARY.contains(id)) continue;
            // A logical id may also BE a physical id (Java registers the documentation
            // provider under the canonical name), so accept either side of the map.
            if (mapped.contains(id) || ConformanceTest.providerAliases().containsKey(id)) continue;
            unclaimed.add(id);
        }

        assertTrue(
            "These providers ship but no logical id claims them, so a fixture naming that "
                + "logical id would not compose them: " + unclaimed
                + ". Add them to PROVIDER_ALIASES, or to NOT_METAMODEL_VOCABULARY if they are "
                + "genuinely outside the corpus's vocabulary.",
            unclaimed.isEmpty());
    }
}
