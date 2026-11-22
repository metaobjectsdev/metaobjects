package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;
import java.util.Optional;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching OrderController delegates to this interface.
 */
public interface OrderRepository {
    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<OrderDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
    Optional<OrderDto> findById(Long id);
    OrderDto create(OrderDto dto);
    Optional<OrderDto> update(Long id, OrderDto dto);
    Optional<OrderDto> patch(Long id, OrderPatch patch);
    boolean delete(Long id);

    /** M:N traversal: the Tag rows related to this Order through OrderTag. */
    List<TagDto> findTags(Long sourceId);

    /** Reverse nav: the Order rows whose customerId FK points at the given Customer id (single indexed query). */
    List<OrderDto> findByCustomer(Long customerId);
    /** Reverse nav (batched, anti-N+1): the Order rows whose customerId FK is IN the given Customer ids. */
    List<OrderDto> findByCustomerIn(List<Long> customerIds);
}
