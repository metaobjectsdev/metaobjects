package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching CustomerStatusTotalsController delegates to this interface.
 *
 * <p>READ-ONLY: CustomerStatusTotals is a report over a database view, so there is no write method to
 * implement. Its controller answers every write verb with 405.</p>
 */
public interface CustomerStatusTotalsRepository {

    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<CustomerStatusTotalsDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
}
