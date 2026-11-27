import { transport } from "./transport";
import type { ApiError, ErrorCode } from "./types";

/** Erreur affichable : celle du serveur, ou une erreur réseau construite ici. */
export interface AppError {
  code: ErrorCode | "network" | "aborted";
  message: string;
  action: string | null;
  status: number;
  details?: Record<string, string | number | boolean | null>;
}

export class ApiRequestError extends Error implements AppError {
  code: AppError["code"];
  action: string | null;
  status: number;
  details?: AppError["details"];
  constructor(e: AppError) {
    super(e.message);
    this.code = e.code;
    this.action = e.action;
    this.status = e.status;
    this.details = e.details;
  }
}

export const NETWORK_ERROR: AppError = {
  code: "network",
  message: "Le serveur ne répond pas.",
  action: "Vérifiez votre connexion, puis réessayez.",
  status: 0,
};

export function toAppError(err: unknown): AppError {
  if (err instanceof ApiRequestError) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return { code: "aborted", message: "Requête annulée.", action: null, status: 0 };
  }
  return NETWORK_ERROR;
}

async function errorFromResponse(res: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* corps illisible */
  }
  const e = (body as ApiError | null)?.error;
  if (e && typeof e.message === "string" && typeof e.code === "string") {
    return new ApiRequestError({
      code: e.code,
      message: e.message,
      action: typeof e.action === "string" ? e.action : null,
      status: res.status,
      details: e.details,
    });
  }
  return new ApiRequestError({
    code: "internal",
    message: res.status >= 500 ? "Le serveur a rencontré une erreur." : "La requête n'a pas abouti.",
    action: "Réessayez dans un instant.",
    status: res.status,
  });
}

/** Lance la requête et renvoie la réponse brute si elle est en succès (2xx ou 304). */
export async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await transport(`/api${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(NETWORK_ERROR);
  }
  if (!res.ok && res.status !== 304) throw await errorFromResponse(res);
  return res;
}

export async function getJSON<T>(path: string, etag?: string, signal?: AbortSignal): Promise<{ data: T | null; etag: string | null; notModified: boolean }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (etag) headers["if-none-match"] = etag;
  const res = await request(path, { headers, cache: "no-store", signal });
  if (res.status === 304) return { data: null, etag: etag ?? null, notModified: true };
  const data = (await res.json()) as T;
  return { data, etag: res.headers.get("etag"), notModified: false };
}

export async function sendJSON<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const res = await request(path, {
    method,
    // Le serveur exige ce type sur toute requête qui modifie, même sans corps (sinon 415).
    headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function sendFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await request(path, { method: "POST", body: form, headers: { accept: "application/json" } });
  return (await res.json()) as T;
}

/** PUT (remplacement complet, ex. la règle d'automatisation). */
export async function sendPut<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}
