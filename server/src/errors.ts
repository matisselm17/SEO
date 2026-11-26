import type { ApiError, ErrorCode } from "../../shared/api.ts";

type Details = NonNullable<ApiError["error"]["details"]>;

/** Erreur destinée à l'interface : code stable, message en français, action possible. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    message: string,
    public action: string | null = null,
    public details?: Details,
  ) {
    super(message);
  }

  toBody(): ApiError {
    const error: ApiError["error"] = { code: this.code, message: this.message, action: this.action };
    if (this.details) error.details = this.details;
    return { error };
  }

  toErrorObject(): ApiError["error"] {
    return this.toBody().error;
  }
}

export const errors = {
  notFound: (what = "Cette ressource") =>
    new HttpError(404, "not_found", `${what} est introuvable.`, "Revenez à la liste des sites et réessayez."),
  siteNotFound: () =>
    new HttpError(404, "not_found", "Ce site est introuvable. Il a peut-être été supprimé.", "Revenez à la liste des sites."),
  badRequest: (message: string, action: string | null = null) => new HttpError(400, "bad_request", message, action),
  invalidUrl: (message = "Cette adresse n'est pas valide.", url?: string) =>
    new HttpError(
      400,
      "invalid_url",
      message,
      "Saisissez l'adresse publique de votre site, par exemple monsite.fr.",
      url ? { url } : undefined,
    ),
  unreachable: (url: string, reason?: string) =>
    new HttpError(
      422,
      "site_unreachable",
      reason ? `Ce site ne répond pas : ${reason}` : "Ce site ne répond pas.",
      "Vérifiez l'adresse, puis réessayez.",
      { url },
    ),
  siteExists: (siteId: string) =>
    new HttpError(409, "site_exists", "Ce site est déjà suivi.", "Ouvrez-le depuis la liste des sites.", { siteId }),
  auditRunning: () =>
    new HttpError(
      409,
      "audit_running",
      "Une analyse est déjà en cours pour ce site.",
      "Attendez la fin de l'analyse ou arrêtez-la avant d'en relancer une.",
    ),
  noAudit: () =>
    new HttpError(409, "no_audit", "Ce site n'a pas encore été analysé.", "Lancez une analyse, puis réessayez."),
  internal: () =>
    new HttpError(500, "internal", "Une erreur inattendue s'est produite sur le serveur.", "Réessayez dans un instant."),
};

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  return errors.internal();
}
