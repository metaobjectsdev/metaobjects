package com.metaobjects.generator.writer;

import java.util.List;

/**
 * A bracketed, comma-separated list. Printed on one line when the line fits the width;
 * otherwise opener, one item per line (each followed by a comma) and closer.
 *
 * <p>The items are pieces: a {@code String}, another {@code Group}, or a {@code List} or array
 * of pieces, which are concatenated.
 */
public class Group {
  private final String open;
  private final List<Object> items;
  private final String close;
  private final boolean pad;

  /**
   * @param pad {@code { a, b }} (true) versus {@code [a, b]} or {@code f(a, b)} (false) when
   *     printed on one line
   */
  public Group(String open, List<?> items, String close, boolean pad) {
    this.open = open;
    this.items = List.copyOf(items);
    this.close = close;
    this.pad = pad;
  }

  public Group(String open, List<?> items, String close) {
    this(open, items, close, false);
  }

  public String open() {
    return open;
  }

  public List<Object> items() {
    return items;
  }

  public String close() {
    return close;
  }

  public boolean pad() {
    return pad;
  }
}
