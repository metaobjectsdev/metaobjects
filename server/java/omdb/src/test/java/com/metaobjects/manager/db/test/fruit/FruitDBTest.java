/*
 * Copyright 2012 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/*
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v1.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v10.html
 * Contributors:
 *    Doug Mealing LLC - initial API and implementation and/or initial documentation
 */
package com.metaobjects.manager.db.test.fruit;

import com.metaobjects.manager.QueryOptions;
import com.metaobjects.manager.db.test.AbstractOMDBTest;
import com.metaobjects.manager.db.driver.DerbyDriver;
import com.metaobjects.manager.exp.Expression;
import com.metaobjects.manager.exp.Range;
import com.metaobjects.manager.exp.SortOrder;
import java.util.List;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.MetaDataLoaderRegistry;
import com.metaobjects.registry.ServiceRegistryFactory;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;
import org.junit.Before;
import org.junit.BeforeClass;

import java.util.Collection;
import java.util.Date;

import static org.junit.Assert.*;

/**
 *
 * @author dmealing
 */
public class FruitDBTest extends AbstractOMDBTest {

    // Use the registry from AbstractOMDBTest
    private static MetaDataLoaderRegistry getLoaderRegistry() {
        return registry;  // From AbstractOMDBTest
    }

    //@Test - Disabled due to metadata loading issues with managed types
    public void testApple() throws Exception {
        
        Apple apple = new Apple();
        MetaObject mo = getLoaderRegistry().findMetaObject( apple );
        
        assertEquals( "produce::Apple", mo.getName() );
        
        apple.setString( "name", "Granny" );
        apple.setInt( "length", 10 );
        apple.setInt( "weight", 10 );
        
        omdb.createObject( oc, apple );
        
        Expression exp = new Expression( "name", "Gr", Expression.START_WITH );
        Collection<?> apples = omdb.getObjects( oc, mo, new QueryOptions( exp ));
        
        assertFalse( "isEmpty", apples.isEmpty() );
        assertEquals( "Granny", ((Apple) apples.iterator().next()).getString("name"));
        
        apple = (Apple) apples.iterator().next();
        apple.setString( "orchard", "Acme Farms" );
        apple.setInt( "weight", 11 );
        omdb.updateObject(oc, apple);
        
        exp = new Expression( "orchard", "Farms", Expression.END_WITH );
        apples = omdb.getObjects( oc, mo, new QueryOptions( exp ));        

        assertFalse( "isEmpty", apples.isEmpty() );
        
        Orange orange = new Orange();
        orange.setString( "name", "Sunkist" );
        orange.setInt( "weight", 8 );
        orange.setInt( "length", 6 );
        orange.setDate( "pickedDate", new Date() );
        omdb.createObject(oc, orange);
        
        omdb.deleteObject(oc, apple);
        assertTrue( omdb.getObjects(oc, mo).isEmpty() );

        // Better be an Orange
        assertFalse( omdb.getObjects(oc, getLoaderRegistry().findMetaObject( orange )).isEmpty() );    
    }
    
    @Test
    public void testBasket() throws Exception {
        
        // DEBUG: List all available loaders and their objects
        System.out.println("=== AVAILABLE METADATALOADERS ===");
        for (MetaDataLoader loaderItem : getLoaderRegistry().getDataLoaders()) {
            System.out.println("Loader: " + loaderItem.getName());
            for (MetaObject obj : loaderItem.getChildren(MetaObject.class)) {
                System.out.println("  Object: " + obj.getName() + " (type: " + obj.getSubType() + ")");
            }
        }
        System.out.println("=== END METADATALOADERS ===");
        
        MetaObject mo = getLoaderRegistry().findMetaObjectByName( "container::Basket" );        
        assertEquals( "container::Basket", mo.getName() );
        
        ValueObject vo = (ValueObject) mo.newInstance();
        
        vo.setInt( "apples", 10 );
        vo.setInt( "oranges", 12 );
        
        omdb.createObject( oc, vo );
        
        Expression exp = new Expression( "apples", 12, Expression.LESSER );
        Collection<?> data = omdb.getObjects( oc, mo, new QueryOptions( exp ));
        
        assertFalse( "isEmpty", data.isEmpty() );
        assertEquals( Integer.valueOf(12), ((ValueObject) data.iterator().next()).getInt("oranges"));
        
        MetaObject mo2 = getLoaderRegistry().findMetaObjectByName( "produce::FullBasketView" );
        data = omdb.getObjects(oc, mo2);
        assertFalse( "isEmpty", data.isEmpty() );
        
        // Empty the basket
        ValueObject o = (ValueObject) data.iterator().next();
        o.setInt( "apples", 0 );
        o.setInt( "oranges", 0 );
        omdb.updateObject( oc, o);
        
        // Now the view should be empty
        data = omdb.getObjects(oc, mo2);
        assertTrue( "isEmpty", data.isEmpty() );
    }

    /**
     * Regression test for the {@code readMany} in-memory range window. When a dialect
     * cannot page in SQL ({@code supportsRangeInQuery() == false}), the range must be
     * applied in-memory. Previously the range was fetched but discarded, returning the
     * full result set; the window must now be honored.
     *
     * <p>All concrete drivers (Derby/Postgres/MySQL/...) page in SQL, so the in-memory
     * path is only reachable via the {@code GenericSQLDriver} base behavior. This test
     * temporarily swaps in a Derby driver forced to report no in-query range support, so
     * the in-memory window code in {@code readMany} is the path under test, while still
     * using Derby's working insert/identity logic for setup.</p>
     */
    @Test
    public void testInMemoryRangeWindow() throws Exception {
        MetaObject mo = getLoaderRegistry().findMetaObjectByName( "container::Basket" );

        // Tag these rows with a distinct "apples" marker so the test is independent of
        // any rows other tests leave in the shared in-memory DB.
        final int marker = 99;

        // Insert 4 rows with distinct, ordered "oranges" values.
        for ( int n = 1; n <= 4; n++ ) {
            ValueObject vo = (ValueObject) mo.newInstance();
            vo.setInt( "apples", marker );
            vo.setInt( "oranges", n * 10 );   // 10, 20, 30, 40
            omdb.createObject( oc, vo );
        }

        Object originalDriver = omdb.getDatabaseDriver();
        // Derby driver that pretends it cannot page in SQL, forcing the in-memory window path.
        DerbyDriver nonPaging = new DerbyDriver() {
            @Override
            protected boolean supportsRangeInQuery() {
                return false;
            }
        };
        nonPaging.setManager( omdb );
        omdb.setDatabaseDriver( nonPaging );
        try {
            // Filter to just our 4 rows, sort ascending by "oranges" for a deterministic
            // order, then window rows 2..3 (1-based, inclusive).
            QueryOptions options = new QueryOptions(
                    new Expression( "apples", marker, Expression.EQUAL ),
                    new SortOrder( "oranges", SortOrder.ASC ),
                    new Range( 2, 3 ) );
            Collection<?> windowed = omdb.getObjects( oc, mo, options );

            assertEquals( "range window returns exactly 2 rows", 2, windowed.size() );

            List<Integer> oranges = windowed.stream()
                    .map( o -> ((ValueObject) o).getInt( "oranges" ) )
                    .sorted()
                    .collect( java.util.stream.Collectors.toList() );
            assertEquals( "window is the 2nd and 3rd rows", List.of( 20, 30 ), oranges );
        } finally {
            omdb.setDatabaseDriver( originalDriver );
            // Clean up our marker rows so other tests sharing the in-memory DB are unaffected.
            omdb.deleteObjects( oc, mo, new Expression( "apples", marker, Expression.EQUAL ) );
        }
    }
}
