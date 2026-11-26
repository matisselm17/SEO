/**
 * Cache de requêtes minimal, « affiché tout de suite puis rafraîchi » :
 * - une donnée déjà chargée s'affiche immédiatement, puis se rafraîchit en arrière-plan ;
 * - les requêtes identiques en vol sont partagées ;
 * - l'ETag du serveur est renvoyé (If-None-Match) : un 304 garde la donnée telle quelle ;
 * - une erreur de rafraîchissement ne vide jamais ce qui est déjà affiché.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getJSON, toAppError, type AppError } from "./api";

type Fetcher<T> = (ctx: { etag?: string; signal: AbortSignal }) => Promise<{ data: T | null; etag: string | null; notModified: boolean }>;

export interface QueryState<T> {
  data: T | undefined;
  error: AppError | null;
  /** Vrai pendant toute requête, y compris un rafraîchissement silencieux. */
  fetching: boolean;
  updatedAt: number;
}

interface Entry<T = unknown> extends QueryState<T> {
  etag?: string;
  inflight?: Promise<void>;
  controller?: AbortController;
  fetcher: Fetcher<T>;
  stale: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const EMPTY: QueryState<never> = { data: undefined, error: null, fetching: false, updatedAt: 0 };

function emit(key: string) {
  listeners.get(key)?.forEach((l) => l());
}

function defaultFetcher<T>(key: string): Fetcher<T> {
  return ({ etag, signal }) => getJSON<T>(key, etag, signal);
}

function ensure<T>(key: string, fetcher?: Fetcher<T>): Entry<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { ...EMPTY, fetcher: fetcher ?? defaultFetcher<T>(key), stale: true };
    entries.set(key, e as Entry);
  } else if (fetcher) {
    e.fetcher = fetcher;
  }
  return e;
}

function update<T>(key: string, patch: Partial<Entry<T>>) {
  const prev = entries.get(key) as Entry<T> | undefined;
  if (!prev) return;
  // Un nouvel objet à chaque changement : useSyncExternalStore compare par identité.
  entries.set(key, { ...prev, ...patch } as Entry);
  emit(key);
}

export function fetchQuery<T>(key: string, fetcher?: Fetcher<T>): Promise<void> {
  const e = ensure<T>(key, fetcher);
  if (e.inflight) return e.inflight;
  const controller = new AbortController();
  const run = (async () => {
    try {
      const res = await e.fetcher({ etag: (entries.get(key) as Entry<T>)?.etag, signal: controller.signal });
      const current = entries.get(key) as Entry<T> | undefined;
      if (!current) return;
      if (res.notModified && current.data !== undefined) {
        update<T>(key, { fetching: false, error: null, stale: false, inflight: undefined, updatedAt: Date.now() });
      } else {
        update<T>(key, { data: res.data as T, etag: res.etag ?? undefined, fetching: false, error: null, stale: false, inflight: undefined, updatedAt: Date.now() });
      }
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === "aborted") {
        update<T>(key, { fetching: false, inflight: undefined });
        return;
      }
      update<T>(key, { fetching: false, error: appErr, inflight: undefined });
    }
  })();
  update<T>(key, { fetching: true, inflight: run, controller });
  return run;
}

/** Remplace la donnée en cache (mise à jour immédiate après une action ou un événement en direct). */
export function setQueryData<T>(key: string, updater: T | ((prev: T | undefined) => T | undefined)) {
  const e = ensure<T>(key);
  const next = typeof updater === "function" ? (updater as (p: T | undefined) => T | undefined)(e.data) : updater;
  if (next === e.data) return;
  // L'ETag ne correspond plus à la donnée modifiée localement.
  update<T>(key, { data: next, etag: undefined, error: null, updatedAt: Date.now() });
}

export function getQueryData<T>(key: string): T | undefined {
  return (entries.get(key) as Entry<T> | undefined)?.data;
}

/** Marque périmées les clés qui commencent par `prefix` et rafraîchit celles qui sont affichées. */
export function invalidate(prefix: string | ((key: string) => boolean)) {
  const match = typeof prefix === "string" ? (k: string) => k === prefix || k.startsWith(prefix) : prefix;
  for (const key of [...entries.keys()]) {
    if (!match(key)) continue;
    const e = entries.get(key)!;
    e.stale = true;
    if ((listeners.get(key)?.size ?? 0) > 0) void fetchQuery(key);
  }
}

/** Oublie les clés (site supprimé). */
export function removeQueries(prefix: string) {
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) {
      entries.get(key)?.controller?.abort();
      entries.delete(key);
      emit(key);
    }
  }
}

function subscribe(key: string, cb: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

export interface UseQueryResult<T> extends QueryState<T> {
  /** Aucune donnée encore : afficher un skeleton. */
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useQuery<T>(key: string | null, fetcher?: Fetcher<T>): UseQueryResult<T> {
  const sub = useCallback((cb: () => void) => (key ? subscribe(key, cb) : () => {}), [key]);
  const snap = useCallback(() => (key ? ((entries.get(key) as Entry<T> | undefined) ?? EMPTY) : EMPTY), [key]);
  const state = useSyncExternalStore(sub, snap, snap) as QueryState<T>;

  useEffect(() => {
    if (!key) return;
    const e = ensure<T>(key, fetcher);
    // Affiché depuis le cache, puis rafraîchi en arrière-plan.
    if (!e.inflight) void fetchQuery<T>(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refetch = useCallback(() => (key ? fetchQuery<T>(key, fetcher) : Promise.resolve()), [key, fetcher]);
  return {
    data: state.data,
    error: state.error,
    fetching: state.fetching,
    updatedAt: state.updatedAt,
    loading: state.data === undefined && !state.error,
    refetch,
  };
}

/** Précharge une route (survol d'un lien de navigation). */
export function prefetch(key: string) {
  const e = entries.get(key);
  if (e && (e.inflight || (!e.stale && Date.now() - e.updatedAt < 15_000))) return;
  void fetchQuery(key);
}
