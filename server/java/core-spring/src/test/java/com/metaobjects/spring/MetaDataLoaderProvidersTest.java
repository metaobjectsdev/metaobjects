package com.metaobjects.spring;

import com.metaobjects.attr.BooleanAttribute;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.field.StringField;
import com.metaobjects.layout.MetaLayout;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataRegistry;
import com.metaobjects.registry.MetaDataTypeProvider;
import org.junit.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A {@link MetaDataTypeProvider} bean in the context is composed into the application
 * loader's registry, so metadata using the project's own vocabulary loads strict and clean.
 */
public class MetaDataLoaderProvidersTest {

    public static final class PickerLayout extends MetaLayout {
        public PickerLayout(String name) { super("picker", name); }
    }

    static MetaDataTypeProvider contactVocabulary() {
        return new MetaDataTypeProvider() {
            @Override public String getProviderId() { return "spring-test-contact-vocabulary"; }
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
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(MetaDataAutoConfiguration.class))
        .withPropertyValues("metaobjects.metadata-sources=classpath:metadata/test-custom-vocabulary.json");

    @Test
    public void aProviderBeanIsComposedIntoTheApplicationLoader() {
        runner.withBean(MetaDataTypeProvider.class, MetaDataLoaderProvidersTest::contactVocabulary)
            .run(ctx -> {
                MetaDataLoader loader = ctx.getBean(MetaDataLoader.class);
                assertThat(loader.getErrors()).isEmpty();
                assertThat(loader.getTypeRegistry().getTypeDefinition("layout", "picker")).isNotNull();
            });
    }

    @Test
    public void withoutTheProviderBeanTheVocabularyIsRefused() {
        runner.run(ctx -> {
            MetaDataLoader loader = ctx.getBean(MetaDataLoader.class);
            assertThat(loader.getErrors()).extracting(e -> e.getCode().get().name())
                .containsExactly("ERR_UNKNOWN_SUBTYPE", "ERR_UNKNOWN_ATTR");
        });
    }
}
