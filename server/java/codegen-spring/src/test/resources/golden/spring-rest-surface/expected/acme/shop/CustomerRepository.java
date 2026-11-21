package acme.shop;

import com.metaobjects.generator.spring.runtime.FilterPredicate;
import java.util.List;
import java.util.Optional;

/**
 * GENERATED interface — consumer implements with their preferred persistence layer
 * (Spring Data JPA / jOOQ / plain JDBC). The matching CustomerController delegates to this interface.
 */
public interface CustomerRepository {

    /** Sort directive parsed from the cross-port ?sort=<field>:asc|desc grammar. */
    record SortClause(String field, String direction) {}

    List<CustomerDto> list(int limit, int offset, SortClause sort, List<FilterPredicate> filters);
    long count(List<FilterPredicate> filters);
    Optional<CustomerDto> findById(Long id);
    CustomerDto create(CustomerDto dto);
    Optional<CustomerDto> update(Long id, CustomerDto dto);
    Optional<CustomerDto> patch(Long id, CustomerPatch patch);
    boolean delete(Long id);
}
