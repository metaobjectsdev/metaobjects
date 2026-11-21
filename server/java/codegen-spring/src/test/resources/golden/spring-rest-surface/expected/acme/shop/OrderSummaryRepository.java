package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;
import java.util.Optional;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching OrderSummaryController delegates to this interface.
 *
 * <p>READ-ONLY: OrderSummary is a projection over a database view, so there is no write method to
 * implement. Its controller answers every write verb with 405.</p>
 */
public interface OrderSummaryRepository {

    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<OrderSummaryDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
    Optional<OrderSummaryDto> findById(Long id);
}
