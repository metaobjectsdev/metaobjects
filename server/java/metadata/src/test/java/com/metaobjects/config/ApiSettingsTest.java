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
package com.metaobjects.config;

import com.metaobjects.MetaDataException;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/** The {@code api} block of {@code .metaobjects/config.json}: pagination and unknownFields. */
public class ApiSettingsTest {

    private static ApiSettings api(String apiJson) {
        String body = apiJson == null ? "" : ", \"api\": " + apiJson;
        return NeutralConfig.parse("{\"schema_version\": 1" + body + "}", "test").getApiSettings();
    }

    private static String refusal(String apiJson) {
        return assertThrows(MetaDataException.class, () -> api(apiJson)).getMessage();
    }

    @Test
    public void absentBlockHasNoPageSizeAndRejects() {
        ApiSettings a = api(null);
        assertFalse(a.hasPagination());
        assertNull(a.pagination());
        assertTrue(a.rejectsUnknownFields());
        assertEquals(ApiSettings.DEFAULT, a);
    }

    @Test
    public void readsPaginationAndUnknownFields() {
        ApiSettings a = api("{\"pagination\": {\"defaultLimit\": 50, \"maxLimit\": 1000}, \"unknownFields\": \"drop\"}");
        assertEquals(new ApiSettings.Pagination(50, 1000), a.pagination());
        assertFalse(a.rejectsUnknownFields());
        assertEquals(ApiSettings.UnknownFields.DROP, a.unknownFields());
        assertTrue(api("{\"unknownFields\": \"reject\"}").rejectsUnknownFields());
        assertFalse(api("{\"unknownFields\": \"reject\"}").hasPagination());
    }

    @Test
    public void refusesABadBlockNamingTheKey() {
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 0, \"maxLimit\": 5}}")
                .contains("\"api.pagination.defaultLimit\" must be a positive integer"));
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 2.5, \"maxLimit\": 5}}")
                .contains("\"api.pagination.defaultLimit\" must be a positive integer"));
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 5, \"maxLimit\": \"9\"}}")
                .contains("\"api.pagination.maxLimit\" must be a positive integer"));
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 10, \"maxLimit\": 5}}")
                .contains("\"api.pagination.defaultLimit\" must not exceed \"api.pagination.maxLimit\""));
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 10}}").contains("needs both"));
        assertTrue(refusal("{\"pagination\": {\"defaultLimit\": 1, \"maxLimit\": 2, \"x\": 1}}").contains("unknown key \"x\""));
        assertTrue(refusal("{\"unknownFields\": \"ignore\"}").contains("\"api.unknownFields\" must be \"reject\" or \"drop\""));
        assertTrue(refusal("{\"unknownFields\": true}").contains("\"api.unknownFields\" must be \"reject\" or \"drop\""));
        assertTrue(refusal("{\"other\": 1}").contains("\"api\" has an unknown key \"other\""));
        assertTrue(refusal("[]").contains("\"api\" must be an object"));
    }
}
