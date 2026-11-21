package acme.shop;

import java.util.Map;

/**
 * GENERATED — per-object physical database names for Customer.
 */
public abstract class CustomerNames {

    public static final String TYPE = "object";
    public static final String SUB_TYPE = "entity";
    public static final String NAME = "Customer";

    public static final String SOURCE_PRIMARY_TYPE = "source";
    public static final String SOURCE_PRIMARY_SUB_TYPE = "rdb";
    public static final String SOURCE_PRIMARY_KIND = "table";
    public static final String SOURCE_PRIMARY_TABLE = "customers";

    public static final String BALANCE_FIELD = "balance";
    public static final String BALANCE_COLUMN = "balance";
    public static final String CREATED_AT_FIELD = "createdAt";
    public static final String CREATED_AT_COLUMN = "created_at";
    public static final String ID_FIELD = "id";
    public static final String ID_COLUMN = "id";
    public static final String NAME_FIELD = "name";
    public static final String NAME_COLUMN = "name";
    public static final String STATUS_FIELD = "status";
    public static final String STATUS_COLUMN = "status";

    public static final String IDENTITY_PK_TYPE = "identity";
    public static final String IDENTITY_PK_SUB_TYPE = "primary";
    public static final String IDENTITY_PK_NAME = "pk";

    public static final Map<String, String> COLUMNS_BY_FIELD = Map.ofEntries(
        Map.entry("balance", BALANCE_COLUMN),
        Map.entry("createdAt", CREATED_AT_COLUMN),
        Map.entry("id", ID_COLUMN),
        Map.entry("name", NAME_COLUMN),
        Map.entry("status", STATUS_COLUMN)
    );

    protected CustomerNames() {}
}
