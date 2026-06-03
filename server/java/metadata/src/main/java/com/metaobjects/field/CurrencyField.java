package com.metaobjects.field;

import com.metaobjects.*;
import com.metaobjects.attr.StringAttribute;
import com.metaobjects.registry.MetaDataRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Currency field — money stored as integer minor units (cents for USD, yen for
 * JPY, etc.). Carries {@code @currency} (ISO 4217) and an optional
 * {@code @locale} (BCP 47) for downstream formatting; the wire/DB contract is
 * unchanged from {@link LongField} (BIGINT on the wire, {@code long} in Java).
 *
 * <p>Cross-port: the TS/C# ports both implement this as a peer subtype of
 * {@code field.long}. Authoring guarantees a stable physical representation
 * (no float drift) while letting the consumer-side formatting layer apply the
 * appropriate currency symbol and locale rules.</p>
 *
 * @since 7.0.0
 */
@SuppressWarnings("serial")
public class CurrencyField extends PrimitiveField<Long> {

    private static final Logger log = LoggerFactory.getLogger(CurrencyField.class);

    public static final String SUBTYPE_CURRENCY = "currency";
    /** Required ISO 4217 currency code (e.g. {@code USD}, {@code JPY}). */
    public static final String ATTR_CURRENCY = "currency";
    /** Optional BCP 47 locale tag (e.g. {@code en-US}) — for downstream formatting only. */
    public static final String ATTR_LOCALE = "locale";

    public CurrencyField(String name) {
        super(SUBTYPE_CURRENCY, name, DataTypes.LONG);
    }

    public static void registerTypes(MetaDataRegistry registry) {
        try {
            registry.registerType(CurrencyField.class, def -> {
                def.type(TYPE_FIELD).subType(SUBTYPE_CURRENCY)
                   .description("Currency field — integer minor units; carries @currency (ISO 4217)")
                   .inheritsFrom(TYPE_FIELD, SUBTYPE_BASE);

                def.optionalAttributeWithConstraints(ATTR_CURRENCY)
                   .ofType(StringAttribute.SUBTYPE_STRING)
                   .asSingle();

                // @currency is the one canonical (cross-port) currency field attr. The
                // currency presentation @locale (BCP 47) wire contract lives on the
                // view.currency child, not the field — the field-level @locale had no
                // canonical peer and no consumer; dropped SP-G Unit 6c.
            });
            if (log != null) log.debug("Registered CurrencyField type with unified registry");
        } catch (Exception e) {
            if (log != null) log.error("Failed to register CurrencyField type with unified registry", e);
        }
    }
}
