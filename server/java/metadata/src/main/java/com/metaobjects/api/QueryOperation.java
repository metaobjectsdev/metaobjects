/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
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
package com.metaobjects.api;

/** {@code operation.query} (ADR-0030): a named operation that reads. Registered by {@link CommandOperation#registerTypes}. */
@SuppressWarnings("serial")
public class QueryOperation extends MetaOperation {

    public QueryOperation(String name) {
        super(ApiConstants.OPERATION_SUBTYPE_QUERY, name);
    }
}
