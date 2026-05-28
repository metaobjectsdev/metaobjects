// TemplateGenerator — C# port of the TS rc.12 templateGenerator() factory.
//
// Walks the loaded MetaRoot via a caller-supplied walk callback, renders the
// shared Mustache template via MetaObjects.Render, and emits EmittedFile per
// walk entry. Same IGenerator interface as the hand-coded generators.
//
// Design: spec/design-docs/2026-05-28-cross-port-template-generator.md.
// Cross-port byte-equivalence verified via fixtures/render-conformance/template-generator/.

using MetaObjects.Meta;
using MetaObjects.Render;

namespace MetaObjects.Codegen.Generators;

public record TemplateWalkResult(object Data, string OutputPath);

public static class TemplateGenerator
{
    public static IGenerator Create(
        string name,
        string template,
        Func<MetaRoot, IEnumerable<TemplateWalkResult>> walk,
        IProvider provider,
        string format = "text")
    {
        return new TemplateGeneratorImpl(name, template, walk, provider, format);
    }

    private sealed class TemplateGeneratorImpl : IGenerator
    {
        private readonly string _template;
        private readonly Func<MetaRoot, IEnumerable<TemplateWalkResult>> _walk;
        private readonly IProvider _provider;
        private readonly string _format;

        public string Name { get; }

        public TemplateGeneratorImpl(
            string name, string template,
            Func<MetaRoot, IEnumerable<TemplateWalkResult>> walk,
            IProvider provider, string format)
        {
            Name = name;
            _template = template;
            _walk = walk;
            _provider = provider;
            _format = format;
        }

        public IEnumerable<EmittedFile> Generate(GenContext ctx)
        {
            foreach (var entry in _walk(ctx.Root))
            {
                var request = new RenderRequest
                {
                    Ref = _template,
                    Payload = entry.Data,
                    Provider = _provider,
                    Format = _format,
                };
                var content = Renderer.Render(request);
                yield return new EmittedFile(entry.OutputPath, content);
            }
        }
    }
}
