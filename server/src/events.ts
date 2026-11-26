/**
 * Diffusion des événements d'un site vers les flux SSE ouverts.
 * Les messages « audit » sont limités à 4 par seconde et par site : le dernier état gagne,
 * et il est toujours envoyé (envoi différé), pour que l'état final ne se perde jamais.
 */
import type { SiteEvent } from "../../shared/api.ts";

type Listener = (event: SiteEvent) => void;

export const AUDIT_MIN_INTERVAL_MS = 250;

export class EventHub {
  private listeners = new Map<string, Set<Listener>>();
  private lastAudit = new Map<string, number>();
  private pendingAudit = new Map<string, { timer: NodeJS.Timeout; build: () => SiteEvent | null }>();
  private closers = new Map<string, Set<() => void>>();

  /** Enregistre de quoi fermer un flux ouvert sur ce site. Renvoie la fonction qui retire l'enregistrement. */
  onClose(siteId: string, fn: () => void): () => void {
    let set = this.closers.get(siteId);
    if (!set) this.closers.set(siteId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.closers.delete(siteId);
    };
  }

  /** Ferme tous les flux ouverts sur ce site (site supprimé) : l'interface le découvre à sa reconnexion (404). */
  close(siteId: string): void {
    for (const fn of [...(this.closers.get(siteId) ?? [])]) {
      try {
        fn();
      } catch {
        /* un flux déjà fermé */
      }
    }
    this.closers.delete(siteId);
  }

  subscribe(siteId: string, fn: Listener): () => void {
    let set = this.listeners.get(siteId);
    if (!set) this.listeners.set(siteId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(siteId);
    };
  }

  listenerCount(siteId: string): number {
    return this.listeners.get(siteId)?.size ?? 0;
  }

  emit(siteId: string, event: SiteEvent): void {
    for (const fn of this.listeners.get(siteId) ?? []) {
      try {
        fn(event);
      } catch {
        /* un client défaillant n'empêche pas les autres */
      }
    }
  }

  /**
   * Programme un message « audit ». `build` est appelé au moment de l'envoi, pour refléter l'état réel
   * à cet instant.
   */
  emitAudit(siteId: string, build: () => SiteEvent | null): void {
    const pending = this.pendingAudit.get(siteId);
    if (pending) {
      pending.build = build;
      return;
    }
    const now = Date.now();
    const last = this.lastAudit.get(siteId) ?? 0;
    const wait = Math.max(0, last + AUDIT_MIN_INTERVAL_MS - now);
    const fire = () => {
      const p = this.pendingAudit.get(siteId);
      this.pendingAudit.delete(siteId);
      this.lastAudit.set(siteId, Date.now());
      const ev = (p?.build ?? build)();
      if (ev) this.emit(siteId, ev);
    };
    const timer = setTimeout(fire, wait);
    this.pendingAudit.set(siteId, { timer, build });
  }

  forget(siteId: string): void {
    const p = this.pendingAudit.get(siteId);
    if (p) clearTimeout(p.timer);
    this.pendingAudit.delete(siteId);
    this.lastAudit.delete(siteId);
  }
}
