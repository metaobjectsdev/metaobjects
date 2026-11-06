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

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * FR-023 Phase 2: a lock written by Node {@code meta deps sync} from a {@code maven} or {@code nuget}
 * dependency records {@code resolvedFrom} with the package and the version looked up. This port reads
 * that lock, and its check reports such a dependency {@code unresolved} and names the Node command,
 * because resolving it needs the machine's local Maven repository or NuGet cache.
 */
public class PackagedTransportDependenciesTest {

    private static final String INTEGRITY = "sha256-10fbf886e22faceca32c56e5e647c3ff1c82f503e638cba3bd3aa9390f7c409d";

    private static String lockWith(String resolvedFrom) {
        return "{\"schema_version\":1,\"dependencies\":{\"acme-common\":{\"version\":\"1.0.0\","
                + "\"metamodelVersion\":\"1.0\",\"resolvedFrom\":" + resolvedFrom + ","
                + "\"artifact\":\"acme-common.metaobjects.json\",\"integrity\":\"" + INTEGRITY + "\","
                + "\"packages\":[\"acme::common\"],\"nodes\":[\"acme::common::Customer\"]}}}";
    }

    @Test
    public void readsALockWhoseResolvedFromIsAMavenOrNugetPackage() {
        assertEquals(1, Dependencies.parseLock(
                lockWith("{\"maven\":\"com.acme:model\",\"version\":\"1.0.0\"}"), "test").size());
        assertEquals(1, Dependencies.parseLock(
                lockWith("{\"maven\":\"com.acme:model\",\"version\":\"1.0.0\",\"dir\":\"shared\"}"), "test").size());
        assertEquals(1, Dependencies.parseLock(
                lockWith("{\"nuget\":\"Acme.Model\",\"version\":\"1.0.0\"}"), "test").size());
    }

    @Test
    public void refusesAPackagedResolvedFromWithoutItsVersion() {
        for (String bad : List.of("{\"maven\":\"com.acme:model\"}", "{\"nuget\":\"Acme.Model\",\"version\":\"\"}",
                "{\"npm\":\"@x/y\",\"version\":\"1.0.0\"}")) {
            MetaDataException e = assertThrows(MetaDataException.class, () -> Dependencies.parseLock(lockWith(bad), "test"));
            assertEquals(ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE, e.getCode().orElse(null));
        }
    }

    @Test
    public void checkReportsAPackagedDependencyUnresolvedAndNamesTheNodeCommand() {
        Map<String, Dependencies.LockEntry> lock = Dependencies.parseLock(
                lockWith("{\"maven\":\"com.acme:model\",\"version\":\"1.0.0\"}"), "test");
        for (String key : List.of("maven", "nuget")) {
            Map<String, String> spec = Map.of("name", "acme-common", key, "x", "version", "1.0.0");
            List<Dependencies.CheckResult> results =
                    Dependencies.check(Path.of("."), List.of(spec), Optional.of(lock));
            assertEquals(1, results.size());
            assertEquals(Dependencies.CheckStatus.UNRESOLVED, results.get(0).status());
            assertTrue(results.get(0).detail().contains("\"" + key + "\" transport"));
            assertTrue(results.get(0).detail().contains("meta deps check"));
        }
    }
}
