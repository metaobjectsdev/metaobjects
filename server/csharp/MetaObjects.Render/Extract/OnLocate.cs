namespace MetaObjects.Render.Extract;

/// <summary>
/// FR-364: the document-level locate hook. Called ONCE per extraction, before the default
/// locator runs.
/// Return <c>null</c> to fall back to the default locator (the fenced-then-first-object rule
/// #363 fixed); return a substring to use it as the payload span instead.
/// <para>
/// <paramref name="text"/> — the RAW reply text (never null; an absent document is normalized
/// to <c>""</c> before the hook runs).<br/>
/// <paramref name="format"/> — the schema's declared <see cref="Format"/>.
/// </para>
/// A non-null return is parsed by the normal pipeline exactly like a default-located span —
/// tolerance, coercion, <c>Normalizers</c>, and <see cref="OnField"/> downstream are
/// unaffected — so this hook only decides WHICH text is the payload, never how it is parsed.
/// The returned text need not be a literal substring of the input (the hook may synthesize
/// it). A thrown exception propagates (it is not swallowed), matching <see cref="OnField"/>.
/// </summary>
public delegate string? OnLocate(string text, Format format);
