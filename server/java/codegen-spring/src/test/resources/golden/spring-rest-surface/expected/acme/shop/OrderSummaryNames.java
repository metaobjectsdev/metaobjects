package acme.shop;

import java.util.Map;

/**
 * GENERATED — per-object physical database names for OrderSummary.
 */
public abstract class OrderSummaryNames {
    public static final String TYPE = "object";
    public static final String SUB_TYPE = "projection";
    public static final String NAME = "OrderSummary";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "view";
    public static final String SOURCE_PRIMARY_VIEW = "v_order_summary";

    public static final String ID_FIELD = "id";
    public static final String ID_COLUMN = "id";
    public static final String PLACED_ON_FIELD = "placedOn";
    public static final String PLACED_ON_COLUMN = "placed_on";
    public static final String TOTAL_FIELD = "total";
    public static final String TOTAL_COLUMN = "total";

    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("id", ID_COLUMN),
        Map.entry("placedOn", PLACED_ON_COLUMN),
        Map.entry("total", TOTAL_COLUMN)
    );

    protected OrderSummaryNames() {}
}
