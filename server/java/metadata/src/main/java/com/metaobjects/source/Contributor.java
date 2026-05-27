/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

/**
 * One contributor in a {@link MergedSource} (FR5c reserved slot).
 *
 * <p>Mirrors {@code Contributor} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param file project-root-relative path with forward slashes
 * @param role one of {@code "overlay-base"} / {@code "overlay-extension"} /
 *             {@code "extends-base"} / {@code "extends-extension"}
 */
public record Contributor(String file, String role) {
}
