package com.metaobjects.mojo;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.apache.maven.plugin.MojoExecutionException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * The {@code <providers>} parameter reaches every goal that loads metadata: a project's own
 * vocabulary loads under generate, verify and fmt, and is refused (strict) without it.
 */
public class MojoProvidersTest {

    public static final class PickerLayout extends MetaLayout {
        public PickerLayout(String name) { super("picker", name); }
    }

    /** Public, no-arg: what {@code <providers>} instantiates. */
    public static final class ContactVocabulary implements MetaDataTypeProvider {
        @Override public String getProviderId() { return "mojo-test-contact-vocabulary"; }
        @Override public String[] getDependencies() { return new String[]{"field-types", "layout-types"}; }
        @Override public void registerTypes(MetaDataRegistry registry) {
            registry.registerType(PickerLayout.class, def -> {
                def.type("layout").subType("picker").inheritsFrom("layout", "base");
                def.optionalAttributeWithConstraints("displayField")
                   .ofType(StringAttribute.SUBTYPE_STRING).asSingle();
            });
            registry.extendType(StringField.class, def ->
                def.optionalAttributeWithConstraints("searchable")
                   .ofType(BooleanAttribute.SUBTYPE_BOOLEAN).asSingle());
        }
    }

    public static final class NoPublicCtor implements MetaDataTypeProvider {
        public NoPublicCtor(String ignored) { }
        @Override public String getProviderId() { return "x"; }
        @Override public void registerTypes(MetaDataRegistry registry) { }
    }

    private static final String PROVIDER = ContactVocabulary.class.getName();

    private static final String CONTACTS =
        "{\n  \"metadata.root\": {\n    \"package\": \"examples\",\n    \"children\": [\n"
        + "      {\n        \"object.value\": {\n          \"name\": \"Contact\",\n"
        + "          \"children\": [\n"
        + "            {\n              \"field.string\": {\n                \"name\": \"name\",\n"
        + "                \"@searchable\": true\n              }\n            },\n"
        + "            {\n              \"layout.picker\": {\n                \"name\": \"contactPicker\",\n"
        + "                \"@displayField\": \"name\"\n              }\n            }\n"
        + "          ]\n        }\n      }\n    ]\n  }\n}\n";

    private Path dir;
    private Path out;

    @Before
    public void setUp() throws Exception {
        dir = Files.createTempDirectory("mojo-providers-meta");
        out = Files.createTempDirectory("mojo-providers-out");
        Files.writeString(dir.resolve("meta.contacts.json"), CONTACTS, StandardCharsets.UTF_8);
    }

    @After
    public void tearDown() throws Exception {
        for (Path root : List.of(dir, out)) {
            try (var walk = Files.walk(root)) {
                walk.sorted(java.util.Comparator.reverseOrder()).forEach(p -> {
                    try { Files.delete(p); } catch (Exception ignored) { }
                });
            }
        }
    }

    private void configure(AbstractMetaDataMojo mojo, String... providerClasses) {
        mojo.setLoader(LoaderParam.builder("providers-test")
            .withClassname("com.metaobjects.loader.MetaDataLoader")
            .withSourceDir(dir.toString())
            .build());
        mojo.setGenerators(new ArrayList<>(List.of(GeneratorParam.builder(KotlinEntityGenerator.class.getName())
            .withArg("outputDir", out.toString()).build())));
        mojo.setGlobals(Collections.emptyMap());
        mojo.providers = providerClasses.length == 0 ? null : List.of(providerClasses);
    }

    @Test
    public void generateRefusesTheVocabularyWithoutProviders() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen);
        Exception e = assertThrows(Exception.class, gen::execute);
        assertTrue(String.valueOf(e.getMessage()), e.getMessage().contains("strict provenance (2 error(s))"));
    }

    @Test
    public void generateLoadsTheVocabularyWithProviders() throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, PROVIDER);
        gen.execute();
    }

    @Test
    public void verifyLoadsTheVocabularyWithProviders() throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, PROVIDER);
        gen.execute();

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, PROVIDER);
        verify.execute();

        MetaDataVerifyMojo without = new MetaDataVerifyMojo();
        configure(without);
        assertThrows(Exception.class, without::execute);
    }

    @Test
    public void fmtLoadsTheVocabularyWithProvidersInEveryReload() throws Exception {
        MetaDataFmtMojo fmt = new MetaDataFmtMojo();
        configure(fmt, PROVIDER);
        fmt.execute();
        assertEquals(CONTACTS, Files.readString(dir.resolve("meta.contacts.json"), StandardCharsets.UTF_8));

        MetaDataFmtMojo without = new MetaDataFmtMojo();
        configure(without);
        assertThrows(Exception.class, without::execute);
    }

    @Test
    public void aMissingClassNamesTheClasspathRule() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, "com.example.DoesNotExist");
        MojoExecutionException e = assertThrows(MojoExecutionException.class, gen::execute);
        assertTrue(e.getMessage(), e.getMessage().contains("com.example.DoesNotExist"));
        assertTrue(e.getMessage(), e.getMessage().contains("plugin's classpath"));
        assertTrue(e.getMessage(), e.getMessage().contains("not compiled yet at generate-sources"));
    }

    @Test
    public void aNonProviderClassIsRefused() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, String.class.getName());
        MojoExecutionException e = assertThrows(MojoExecutionException.class, gen::execute);
        assertTrue(e.getMessage(), e.getMessage().contains("does not implement"));
    }

    @Test
    public void aProviderWithoutAPublicNoArgConstructorIsRefused() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, NoPublicCtor.class.getName());
        MojoExecutionException e = assertThrows(MojoExecutionException.class, gen::execute);
        assertTrue(e.getMessage(), e.getMessage().contains("public no-argument constructor"));
    }
}
