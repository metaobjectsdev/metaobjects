namespace MetaObjects.Render;

/// <summary>A rendered email: subject + HTML body + optional plain-text alternative (MIME multipart/alternative).</summary>
public sealed record EmailDocument(string Subject, string HtmlBody, string? TextBody = null);
