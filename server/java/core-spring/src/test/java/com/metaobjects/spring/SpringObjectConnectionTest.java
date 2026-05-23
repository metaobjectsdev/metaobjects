package com.metaobjects.spring;

import com.metaobjects.manager.ObjectConnection;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit4.SpringJUnit4ClassRunner;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.Assert.*;

/**
 * Verifies that SpringObjectConnections joins the caller's Spring-managed transaction:
 * <ol>
 *   <li>The ObjectConnection wraps the SAME physical connection Spring bound to the tx.</li>
 *   <li>close() on the wrapper is a no-op — Spring owns the lifecycle.</li>
 *   <li>DML executed through the connection participates in Spring rollback.</li>
 * </ol>
 */
@RunWith(SpringJUnit4ClassRunner.class)
@ContextConfiguration(classes = SpringObjectConnectionTest.TestConfig.class)
public class SpringObjectConnectionTest {

    @Configuration
    static class TestConfig {

        @Bean
        public DataSource dataSource() {
            return new EmbeddedDatabaseBuilder()
                    .setType(EmbeddedDatabaseType.H2)
                    .build();
        }

        @Bean
        public PlatformTransactionManager transactionManager(DataSource dataSource) {
            return new DataSourceTransactionManager(dataSource);
        }

        @Bean
        public TransactionTemplate transactionTemplate(PlatformTransactionManager transactionManager) {
            return new TransactionTemplate(transactionManager);
        }
    }

    @Autowired
    private DataSource dataSource;

    @Autowired
    private TransactionTemplate transactionTemplate;

    @Before
    public void createTable() throws Exception {
        try (Connection c = dataSource.getConnection();
             Statement st = c.createStatement()) {
            st.execute("CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY)");
        }
    }

    /**
     * Test 1 — same connection + no-close.
     *
     * Inside a Spring transaction, SpringObjectConnections.current() must return the
     * exact same physical Connection that Spring bound to the transaction. After
     * calling close() on the wrapper the underlying connection must still be open
     * (Spring, not the wrapper, owns the lifecycle).
     */
    @Test
    public void testJoinsTransactionAndCloseIsNoOp() throws Exception {
        transactionTemplate.execute(status -> {
            try {
                ObjectConnection oc = SpringObjectConnections.current(dataSource);
                Connection springConn = DataSourceUtils.getConnection(dataSource);

                // The wrapped connection must be the same physical object Spring bound.
                Connection wrappedConn = (Connection) oc.getDatastoreConnection();
                assertSame(
                        "SpringObjectConnections must return the tx-bound connection",
                        springConn, wrappedConn);

                // close() must be a no-op — Spring owns the lifecycle.
                oc.close();
                assertFalse(
                        "Underlying connection must still be open after wrapper close()",
                        wrappedConn.isClosed());

                // Release the extra reference obtained above (DataSourceUtils contract).
                DataSourceUtils.releaseConnection(springConn, dataSource);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
            return null;
        });
    }

    /**
     * Test 2 — rollback participation.
     *
     * DML executed via the connection obtained from SpringObjectConnections.current()
     * must be rolled back when the surrounding Spring transaction rolls back.
     * After the rollback the row must be absent.
     */
    @Test
    public void testRollbackRemovesRow() throws Exception {
        // Execute inside a transaction that we force to roll back.
        try {
            transactionTemplate.execute(status -> {
                try {
                    ObjectConnection oc = SpringObjectConnections.current(dataSource);
                    Connection conn = (Connection) oc.getDatastoreConnection();
                    try (PreparedStatement ps = conn.prepareStatement("INSERT INTO t VALUES (1)")) {
                        ps.executeUpdate();
                    }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
                // Force rollback by throwing an unchecked exception.
                throw new RuntimeException("intentional rollback");
            });
        } catch (RuntimeException ignored) {
            // expected — transaction has been rolled back
        }

        // Verify the row is absent on a fresh, non-transactional connection.
        try (Connection c = dataSource.getConnection();
             Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM t WHERE id = 1")) {
            assertTrue(rs.next());
            assertEquals(
                    "Row must be absent after rollback — OMDB connection participated in the Spring tx",
                    0, rs.getInt(1));
        }
    }
}
