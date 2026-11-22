package acme.shop;

import java.util.Map;

/**
 * GENERATED — per-object physical database names for Order.
 */
public abstract class OrderNames {
    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "Order";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "table";
    public static final String SOURCE_PRIMARY_TABLE = "orders";

    public static final String CUSTOMER_ID_FIELD = "customerId";
    public static final String CUSTOMER_ID_COLUMN = "customer_id";
    public static final String ID_FIELD = "id";
    public static final String ID_COLUMN = "id";
    public static final String PLACED_ON_FIELD = "placedOn";
    public static final String PLACED_ON_COLUMN = "placed_on";
    public static final String RUSH_FIELD = "rush";
    public static final String RUSH_COLUMN = "rush";
    public static final String TOTAL_FIELD = "total";
    public static final String TOTAL_COLUMN = "total";

    public static final String IDENTITY_FK_CUSTOMER_TYPE = "identity";
    public static final String IDENTITY_FK_CUSTOMER_SUB_TYPE = "reference";
    public static final String IDENTITY_FK_CUSTOMER_NAME = "fkCustomer";
    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("customerId", CUSTOMER_ID_COLUMN),
        Map.entry("id", ID_COLUMN),
        Map.entry("placedOn", PLACED_ON_COLUMN),
        Map.entry("rush", RUSH_COLUMN),
        Map.entry("total", TOTAL_COLUMN)
    );

    protected OrderNames() {}
}
