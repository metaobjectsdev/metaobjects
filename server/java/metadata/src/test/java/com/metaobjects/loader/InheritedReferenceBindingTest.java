/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.loader;

import com.metaobjects.MetaDataException;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.identity.ReferenceIdentity;
import com.metaobjects.object.MetaObject;
import com.metaobjects.relationship.MetaRelationship;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0059 Decision 7: an attribute a root-level object declares keeps the meaning it had
 * where it was written when a packaged object inherits it, even when that package declares an
 * object of the same short name. The root file also feeds a reporting {@code @via} hop, which
 * validates before the resolve pass and so must apply the declaring package too.
 */
public class InheritedReferenceBindingTest {

    private static final String ROOT = "{\"metadata.root\":{\"children\":["
        + "{\"object.entity\":{\"name\":\"Customer\",\"children\":["
        + "{\"source.rdb\":{\"@table\":\"customers\"}},"
        + "{\"field.long\":{\"name\":\"id\"}},"
        + "{\"field.string\":{\"name\":\"region\"}},"
        + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}}]}},"
        + "{\"object.entity\":{\"name\":\"BaseOrder\",\"abstract\":true,\"children\":["
        + "{\"field.long\":{\"name\":\"id\"}},"
        + "{\"field.long\":{\"name\":\"customerId\"}},"
        + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"id\"]}},"
        + "{\"identity.reference\":{\"name\":\"customerRef\",\"@references\":\"Customer\",\"@fields\":[\"customerId\"]}},"
        + "{\"relationship.association\":{\"name\":\"customer\",\"@objectRef\":\"Customer\",\"@cardinality\":\"one\"}}]}}"
        + "]}}";

    private static final String ACME = "{\"metadata.root\":{\"package\":\"acme\",\"children\":["
        + "{\"object.entity\":{\"name\":\"Customer\",\"children\":["
        + "{\"source.rdb\":{\"@table\":\"acme_customers\"}},"
        + "{\"field.string\":{\"name\":\"code\"}},"
        + "{\"identity.primary\":{\"name\":\"id\",\"@fields\":[\"code\"]}}]}},"
        + "{\"object.entity\":{\"name\":\"Order\",\"extends\":\"::BaseOrder\",\"children\":["
        + "{\"source.rdb\":{\"@table\":\"orders\"}},"
        + "{\"dimension.attribute\":{\"name\":\"region\",\"@of\":\"Customer.region\",\"@via\":\"Order.customer\"}}]}}"
        + "]}}";

    private static MetaDataLoader load() {
        MetaDataLoader loader = new MetaDataLoader(LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "");
        loader.init();
        try {
            loader.load(List.of(new InMemoryStringSource(ACME, "acme.json"),
                new InMemoryStringSource(ROOT, "root.json")));
        } catch (MetaDataException ex) {
            loader.addError(ex);
        }
        return loader;
    }

    @Test
    public void viaHopOfAnInheritedRelationshipResolvesInTheDeclaringPackage() {
        MetaDataLoader loader = load();
        assertTrue("unexpected errors: " + loader.getErrors(), loader.getErrors().isEmpty());
    }

    @Test
    public void inheritedReferencesBindTheRootObject() {
        MetaDataLoader loader = load();
        assertTrue("unexpected errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        MetaObject root = loader.getMetaObjectByName("Customer");
        MetaObject acme = loader.getMetaObjectByName("acme::Customer");
        MetaObject order = loader.getMetaObjectByName("acme::Order");
        assertNotNull(root);
        assertNotNull(acme);

        MetaRelationship customer = null;
        for (MetaRelationship r : order.getRelationships()) {
            if ("customer".equals(r.getShortName())) customer = r;
        }
        assertNotNull(customer);
        assertSame(root, References.refTarget(customer, MetaRelationship.ATTR_OBJECT_REF));
        assertSame(root, References.lookupCanonical(loader.getRoot(),
            customer.getMetaAttr(MetaRelationship.ATTR_OBJECT_REF).getValueAsString()));

        ReferenceIdentity customerRef = null;
        for (MetaIdentity id : order.getIdentities()) {
            if (id instanceof ReferenceIdentity && "customerRef".equals(id.getShortName())) {
                customerRef = (ReferenceIdentity) id;
            }
        }
        assertNotNull(customerRef);
        assertSame(root, References.refTarget(customerRef, MetaIdentity.ATTR_REFERENCES));
        assertSame(root, References.lookupCanonical(loader.getRoot(),
            customerRef.getMetaAttr(MetaIdentity.ATTR_REFERENCES).getValueAsString()));
        assertEquals("acme::Customer", acme.getName());
    }
}
