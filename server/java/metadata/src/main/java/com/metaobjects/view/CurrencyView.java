package com.metaobjects.view;

import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Currency view — presentation-side companion of {@code field.currency}.
 *
 * <p>Carries an optional {@code @locale} (BCP 47) used by client formatting
 * (e.g. {@code Intl.NumberFormat}). Wire/DB shape is unchanged; the view is
 * purely a hint to downstream rendering. Cross-port: TS/C# both register
 * this peer of {@code view.base}.</p>
 *
 * @since 7.0.0
 */
public class CurrencyView extends MetaView {

    private static final Logger log = LoggerFactory.getLogger(CurrencyView.class);

    public static final String SUBTYPE_CURRENCY = "currency";
    /** Optional BCP 47 locale tag (e.g. {@code en-US}, {@code ja-JP}). */
    public static final String ATTR_LOCALE = "locale";

    public CurrencyView(String name) {
        super(TYPE_VIEW, SUBTYPE_CURRENCY, name);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(CurrencyView.class, def -> {
                def.type(TYPE_VIEW).subType(SUBTYPE_CURRENCY)
                   .description("Currency view — optional @locale for downstream formatting")
                   .inheritsFrom(TYPE_VIEW, SUBTYPE_BASE);

                def.optionalAttributeWithConstraints(ATTR_LOCALE)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .asSingle();
            });
            log.debug("Registered CurrencyView type with unified registry");
        } catch (Exception e) {
            log.error("Failed to register CurrencyView type with unified registry", e);
        }
    }
}
