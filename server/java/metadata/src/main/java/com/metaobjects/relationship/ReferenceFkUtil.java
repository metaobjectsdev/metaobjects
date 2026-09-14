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
package com.metaobjects.relationship;

import com.metaobjects.MetaData;
import com.metaobjects.identity.MetaIdentity;

import java.util.List;

/**
 * Package-private helpers shared by {@link M2MFields} and
 * {@link RelationshipReferences} — both independently needed "the FK field an
 * {@code identity.reference} is anchored on" and "the bare (package-stripped)
 * tail of a dotted name" before this class existed, and had grown byte-for-byte
 * duplicate private copies of each (fix round 1, finding 5). Kept here rather
 * than made public: the other language ports keep this logic in separate
 * modules (no cross-file sharing to mirror), so there is no cross-port reason
 * to widen visibility beyond this package.
 */
final class ReferenceFkUtil {

    private ReferenceFkUtil() {
        // static utility class
    }

    /** The FK field an identity carries (first {@code @fields} entry; composite FKs
     *  key on their first column), or {@code null} when it declares no {@code @fields}. */
    static String refFkField(MetaIdentity ref) {
        List<String> fields = ref.getFields();
        return fields.isEmpty() ? null : fields.get(0);
    }

    /** Last {@code ::}-segment of a (possibly package-qualified, possibly null/empty) name. */
    static String stripPackage(String name) {
        if (name == null || name.isEmpty()) return "";
        int idx = name.lastIndexOf(MetaData.PKG_SEPARATOR);
        return idx < 0 ? name : name.substring(idx + MetaData.PKG_SEPARATOR.length());
    }
}
