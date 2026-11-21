package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;
import java.util.Optional;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching OrderTagController delegates to this interface.
 */
public interface OrderTagRepository {

    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<OrderTagDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
    Optional<OrderTagDto> findById(Long id);
    OrderTagDto create(OrderTagDto dto);
    Optional<OrderTagDto> update(Long id, OrderTagDto dto);
    Optional<OrderTagDto> patch(Long id, OrderTagPatch patch);
    boolean delete(Long id);

    /** Reverse nav: the OrderTag rows whose orderId FK points at the given Order id (single indexed query). */
    List<OrderTagDto> findByOrder(Long orderId);
    /** Reverse nav (batched, anti-N+1): the OrderTag rows whose orderId FK is IN the given Order ids. */
    List<OrderTagDto> findByOrderIn(List<Long> orderIds);

    /** Reverse nav: the OrderTag rows whose tagId FK points at the given Tag id (single indexed query). */
    List<OrderTagDto> findByTag(Long tagId);
    /** Reverse nav (batched, anti-N+1): the OrderTag rows whose tagId FK is IN the given Tag ids. */
    List<OrderTagDto> findByTagIn(List<Long> tagIds);
}
