package com.metaobjects.loader;

import com.metaobjects.MetaDataException;
import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import com.metaobjects.registry.RegistryManifest;
import org.junit.Test;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.*;

/** A project's own vocabulary reaches the loader through every {@code from*} factory. */
public class LoaderProvidersTest {

    /** A project's own layout subtype. */
    public static final class PickerLayout extends MetaLayout {
        public PickerLayout(String name) { super("picker", name); }
    }

    static final MetaDataTypeProvider PROVIDER = new MetaDataTypeProvider() {
        @Override public String getProviderId() { return "loader-providers-test"; }
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
    };

    static final String JSON = """
        {"metadata.root": {"package": "p", "children": [
          {"object.value": {"name": "Contact", "children": [
            {"field.string": {"name": "name", "@searchable": true}},
            {"layout.picker": {"name": "pick", "@displayField": "name"}}
          ]}}
        ]}}
        """;

    private static LoaderOptions strict() { return LoaderOptions.create(false, false, true); }

    @Test public void fromStringComposesProviders() {
        MetaDataLoader loader = MetaDataLoader.fromString("p", JSON,
            MetaDataSource.MetaDataFormat.JSON, strict().setProviders(List.of(PROVIDER)));
        assertTrue(loader.getErrors().isEmpty());
        assertTrue(loader.getTypeRegistry().isSealed());
        assertNotSame(RegistryManifest.defaultLoaderRegistry(), loader.getTypeRegistry());
    }

    @Test public void withoutProvidersTheStrictLoadRefusesAndDefaultRegistryIsShared() {
        MetaDataLoader loader = MetaDataLoader.createManual(false, "p");
        loader.getLoaderOptions().setStrict(true);
        assertSame(RegistryManifest.defaultLoaderRegistry(), loader.getTypeRegistry());
        MetaDataLoader refused = MetaDataLoader.fromString("p", JSON,
            MetaDataSource.MetaDataFormat.JSON, strict());
        assertEquals(List.of("ERR_UNKNOWN_SUBTYPE", "ERR_UNKNOWN_ATTR"),
            refused.getErrors().stream().map(e -> e.getCode().get().name()).toList());
    }

    @Test public void fromDirectoryAndFromUrisAndFromResourcesAcceptProviders() throws Exception {
        Path dir = Files.createTempDirectory("providers-test");
        Path f = dir.resolve("meta.contacts.json");
        Files.writeString(f, JSON);
        MetaDataLoader d = MetaDataLoader.fromDirectory("p", dir,
            new DirectorySource.Options(), null, List.of(PROVIDER));
        assertTrue(d.getTypeRegistry().hasType("layout"));
        assertNotNull(d.getTypeRegistry().getTypeDefinition("layout", "picker"));

        MetaDataLoader u = MetaDataLoader.fromUris("p", List.of(URI.create(f.toUri().toString())),
            strict().setProviders(List.of(PROVIDER)));
        assertNotNull(u.getTypeRegistry().getTypeDefinition("layout", "picker"));
    }

    @Test public void composeLoaderRegistryIsFreshAndSealedEachCall() {
        MetaDataRegistry a = RegistryManifest.composeLoaderRegistry(List.of(PROVIDER));
        MetaDataRegistry b = RegistryManifest.composeLoaderRegistry(List.of(PROVIDER));
        assertNotSame(a, b);
        assertTrue(a.isSealed());
    }

    @Test public void defaultOptionsEqualityIgnoresNothingNew() {
        assertEquals(LoaderOptions.create(false, false, true), LoaderOptions.create(false, false, true));
        assertNotEquals(strict(), strict().setProviders(List.of(PROVIDER)));
    }
}
