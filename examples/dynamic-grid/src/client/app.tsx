/**
 * The demo's shell: a menu of the entities the server serves, the grid of the chosen one,
 * and the form for the row being created or edited.
 *
 * It names no entity. The menu is the model's entity list, and `<MetaGrid>` / `<MetaForm>`
 * are handed a name from it. Save the metadata file while this page is open and the page
 * picks up the new model within a moment (`pollMs`), with nothing regenerated or rebuilt.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { joinBaseUrl, type EntityFetcher } from "@metaobjectsdev/runtime-web";
import { EntityFetcherProvider } from "@metaobjectsdev/tanstack";
import { describeError, jsonFetcher, loadClientModel, servedRevision, type Row } from "./api";
import { ModelProvider } from "./context";
import { MetaForm } from "./meta-form";
import { MetaGrid } from "./meta-grid";
import type { ClientModel, EntityModel } from "./model";

export interface AppProps {
  /** Transport. The default is `fetch`. */
  readonly fetcher?: EntityFetcher;
  /** Where the API is mounted. */
  readonly baseUrl?: string;
  /** How often to ask whether the model changed, in milliseconds. 0 turns it off. */
  readonly pollMs?: number;
}

/** What the page shows: an entity's list, and optionally one of its rows (or a new one) in the form. */
interface View {
  readonly entity: string;
  readonly form?: { readonly id?: string | number; readonly initial?: Row };
}

function Workspace({ model }: { readonly model: ClientModel }): ReactNode {
  const [view, setView] = useState<View | undefined>(undefined);
  // Bumped after every write, so the lists on the page fetch again.
  const [written, setWritten] = useState(0);
  // The chosen entity, or the first one: a reload may have removed the one that was open.
  const entity: EntityModel | undefined = (view === undefined ? undefined : model.entity(view.entity)) ?? model.entities[0];
  if (entity === undefined) return <p>The model serves no entities.</p>;
  const form = view?.entity === entity.name ? view.form : undefined;
  const wrote = (): void => setWritten((n) => n + 1);

  return (
    <div className="mo-workspace">
      <nav aria-label="Entities">
        {model.entities.map((e) => (
          <button key={e.name} type="button" aria-current={e.name === entity.name ? "page" : undefined} onClick={() => setView({ entity: e.name })}>
            {e.label}
          </button>
        ))}
      </nav>
      <main>
        <header>
          <h1>{entity.label}</h1>
          <button type="button" onClick={() => setView({ entity: entity.name, form: {} })}>
            New {entity.label}
          </button>
        </header>
        <MetaGrid entity={entity.name} refresh={written} onOpen={(row) => setView({ entity: entity.name, form: { id: String(row[entity.keyField]) } })} />
      </main>
      {form !== undefined && (
        <aside>
          <MetaForm
            entity={entity.name}
            {...(form.id !== undefined ? { id: form.id } : {})}
            {...(form.initial !== undefined ? { initial: form.initial } : {})}
            onSaved={wrote}
            onDeleted={() => {
              wrote();
              setView({ entity: entity.name });
            }}
            onCancel={() => setView({ entity: entity.name })}
          />
          {/* The rows that belong to this one, for each to-many relationship the model declares. */}
          {form.id !== undefined &&
            entity.related.map((related) => {
              const owner = { [related.via]: form.id as string | number };
              return (
                <section key={related.name} className="mo-related">
                  <header>
                    <h3>{related.label}</h3>
                    <button type="button" onClick={() => setView({ entity: related.entity, form: { initial: owner } })}>
                      Add
                    </button>
                  </header>
                  <MetaGrid
                    entity={related.entity}
                    where={owner}
                    refresh={written}
                    onOpen={(row) => {
                      const target = model.entity(related.entity);
                      if (target !== undefined) setView({ entity: target.name, form: { id: String(row[target.keyField]) } });
                    }}
                  />
                </section>
              );
            })}
        </aside>
      )}
    </div>
  );
}

export function App({ fetcher = jsonFetcher, baseUrl = "", pollMs = 1500 }: AppProps): ReactNode {
  const [model, setModel] = useState<ClientModel | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  // The model and revision routes are relative to the API base, like every entity path.
  const api = useMemo<EntityFetcher>(() => (path, init) => fetcher(joinBaseUrl(baseUrl, path), init), [fetcher, baseUrl]);

  const load = useCallback(async (): Promise<void> => {
    try {
      setModel(await loadClientModel(api));
      setFailure(undefined);
    } catch (err) {
      setFailure(describeError(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const revision = model?.revision;
  useEffect(() => {
    if (pollMs <= 0 || revision === undefined) return;
    const timer = setInterval(() => {
      servedRevision(api).then(
        (served) => {
          if (served !== revision) void load();
        },
        // The server is restarting. The next tick asks again.
        () => undefined,
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [api, load, pollMs, revision]);

  if (model === undefined) return <p role={failure === undefined ? "status" : "alert"}>{failure ?? "Loading the model…"}</p>;
  return (
    <EntityFetcherProvider fetcher={fetcher} baseUrl={baseUrl}>
      <ModelProvider model={model}>
        {failure !== undefined && <p role="alert">{failure}</p>}
        <Workspace model={model} />
        <footer>
          Model revision {model.revision}. {model.entities.length} entities, rendered from <code>{joinBaseUrl(baseUrl, "/_meta")}</code>.
        </footer>
      </ModelProvider>
    </EntityFetcherProvider>
  );
}
