/*
 * Copyright 2003 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.source;

/**
 * Optional YAML source position (FR5b reserved slot).
 *
 * <p>Lines and columns are 1-based, matching the YAML spec and most editors.
 * Mirrors {@code YamlPosition} in
 * {@code server/csharp/MetaObjects/Source/ErrorSource.cs}.</p>
 *
 * @param line 1-based line number in the YAML source
 * @param col 1-based column number in the YAML source
 */
public record YamlPosition(int line, int col) {
}
