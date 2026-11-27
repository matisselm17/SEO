/**
 * Rythme adaptatif d'une analyse face aux refus passagers du site (429 « trop de demandes », 503 indisponible).
 * Un refus passager n'est pas un échec définitif : le parcours ralentit (un seul chargement à la fois,
 * pause plus longue entre deux requêtes), observe une pause (Retry-After s'il existe, plafonné), puis retente
 * la page un nombre borné de fois. Le temps d'attente ajouté est plafonné : l'analyse ne devient jamais interminable.
 * Une instance par analyse ; partagée entre les pages et le catalogue Shopify.
 */

export interface RetryPolicy {
  /** Nouvelles tentatives au plus pour une même adresse (en plus du premier essai). */
  maxRetries: number;
  /** Pause après le premier refus sans Retry-After ; doublée à chaque nouveau refus. */
  firstPauseMs: number;
  /** Pause la plus longue sans Retry-After. */
  maxPauseMs: number;
  /** Retry-After respecté jusqu'à cette durée ; au-delà, l'adresse n'est pas retentée. */
  maxRetryAfterMs: number;
  /** Délai entre deux requêtes dès le premier refus (s'il est plus long que le délai normal). */
  slowDelayMs: number;
  /** Délai le plus long entre deux requêtes (doublé à chaque nouveau refus jusqu'à ce plafond). */
  maxSlowDelayMs: number;
  /** Temps d'attente ajouté au plus pour les pages (pauses + ralentissement), sur toute l'analyse. */
  budgetMs: number;
  /** Temps d'attente au plus pour la lecture du catalogue Shopify (pauses avant nouvelle tentative). */
  catalogueBudgetMs: number;
}

/**
 * Valeurs retenues (voir le rapport) : sur une boutique Shopify, le premier 429 arrive après ~78 requêtes en ~33 s
 * au rythme normal (3 en parallèle, 300 ms) et ne porte pas de Retry-After. Une pause de 5 s, puis un chargement
 * à la fois avec 1 s entre deux requêtes (environ 1 requête par seconde) laisse le compteur du site redescendre.
 */
export const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: 3,
  firstPauseMs: 5_000,
  maxPauseMs: 20_000,
  maxRetryAfterMs: 30_000,
  slowDelayMs: 1_000,
  maxSlowDelayMs: 2_000,
  budgetMs: 90_000,
  catalogueBudgetMs: 45_000,
};

/** Statuts HTTP qui signalent un refus passager. */
export const isTransientStatus = (status: number): boolean => status === 429 || status === 503;

/** Durée demandée par l'en-tête Retry-After (secondes ou date HTTP), en millisecondes ; null si absent ou illisible. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export type Pool = "pages" | "catalogue";

export type RefusalDecision =
  | { retry: true; pauseMs: number }
  | { retry: false; why: "max_retries" | "budget" | "retry_after_too_long" };

export class Throttle {
  /** Nombre de ralentissements (un par vague de refus, pas un par requête refusée). */
  refusals = 0;
  /** Incrémenté à chaque ralentissement : une requête partie avant n'en déclenche pas un autre. */
  epoch = 0;
  concurrency: number;
  delayMs: number;
  private pauseUntil = 0;
  private waited: Record<Pool, number> = { pages: 0, catalogue: 0 };

  constructor(
    readonly policy: RetryPolicy,
    private baseConcurrency: number,
    private baseDelayMs: number,
    private now: () => number = Date.now,
  ) {
    this.concurrency = baseConcurrency;
    this.delayMs = baseDelayMs;
  }

  /** Temps d'attente déjà ajouté, par usage (pour le journal et les tests). */
  waitedMs(pool: Pool): number {
    return this.waited[pool];
  }

  /** Temps restant avant la fin de la pause en cours (0 s'il n'y en a pas). */
  pauseLeftMs(): number {
    return Math.max(0, this.pauseUntil - this.now());
  }

  /**
   * Un refus passager vient d'arriver. `attempt` : nouvelles tentatives déjà faites pour cette adresse ;
   * `startedEpoch` : valeur d'`epoch` au départ de la requête. Ralentit le parcours (une fois par vague)
   * et dit si l'adresse peut être retentée, après quelle pause.
   */
  onRefusal(o: { attempt: number; retryAfterMs: number | null; startedEpoch: number; pool: Pool }): RefusalDecision {
    const p = this.policy;
    const budget = o.pool === "pages" ? p.budgetMs : p.catalogueBudgetMs;
    const tooLong = o.retryAfterMs !== null && o.retryAfterMs > p.maxRetryAfterMs;
    if (o.startedEpoch === this.epoch) {
      // Information nouvelle : on ralentit. Une requête partie avant le ralentissement précédent ne compte pas.
      this.epoch++;
      this.refusals++;
      this.concurrency = 1;
      this.delayMs =
        this.refusals === 1
          ? Math.max(this.baseDelayMs, p.slowDelayMs)
          : Math.max(this.baseDelayMs, Math.min(this.delayMs * 2, p.maxSlowDelayMs));
      const pause =
        o.retryAfterMs !== null
          ? Math.min(Math.max(o.retryAfterMs, 0), p.maxRetryAfterMs)
          : Math.min(p.firstPauseMs * 2 ** (this.refusals - 1), p.maxPauseMs);
      this.extendPause(pause, o.pool, budget);
    }
    if (tooLong) return { retry: false, why: "retry_after_too_long" };
    if (o.attempt >= p.maxRetries) return { retry: false, why: "max_retries" };
    if (this.waited[o.pool] >= budget) return { retry: false, why: "budget" };
    // La pause en cours sert aussi à cette adresse ; sinon (refus d'une requête partie avant), un délai normal suffit.
    return { retry: true, pauseMs: Math.max(this.pauseLeftMs(), this.delayMs) };
  }

  /** Allonge la pause commune sans dépasser le budget d'attente. */
  private extendPause(pauseMs: number, pool: Pool, budget: number): void {
    const now = this.now();
    const target = now + pauseMs;
    const extra = Math.max(0, target - Math.max(this.pauseUntil, now));
    const allowed = Math.max(0, Math.min(extra, budget - this.waited[pool]));
    if (allowed <= 0) return;
    this.pauseUntil = Math.max(this.pauseUntil, now) + allowed;
    this.waited[pool] += allowed;
  }

  /** Délai à observer après une requête de page ; le ralentissement compte dans le budget d'attente des pages. */
  nextDelay(): number {
    const extra = this.delayMs - this.baseDelayMs;
    if (extra > 0) this.waited.pages += extra;
    return this.delayMs;
  }

  /** Le budget d'attente des pages est épuisé : plus de pause ni de nouvelle tentative. */
  exhausted(pool: Pool): boolean {
    return this.waited[pool] >= (pool === "pages" ? this.policy.budgetMs : this.policy.catalogueBudgetMs);
  }

  /** Attend la fin de la pause en cours ; s'interrompt aussitôt à l'arrêt de l'analyse. */
  async waitPause(signal: AbortSignal): Promise<void> {
    for (;;) {
      const left = this.pauseLeftMs();
      if (left <= 0 || signal.aborted) return;
      await sleep(left, signal);
    }
  }
}

export const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
