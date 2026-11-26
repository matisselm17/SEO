/**
 * Lecture de flux Server-Sent Events avec fetch et un lecteur de flux.
 * Sert au flux permanent d'un site (GET /events) et à la réponse de l'assistant (POST /chat).
 */
import { request } from "./api";

export interface SSEMessage {
  event: string;
  data: string;
}

/** Lit un corps text/event-stream et appelle onMessage pour chaque message complet. */
export async function readSSE(res: Response, onMessage: (m: SSEMessage) => void, signal?: AbortSignal): Promise<void> {
  if (!res.body) throw new Error("Flux vide");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue; // commentaire (ping)
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length) onMessage({ event, data: data.join("\n") });
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export type StreamStatus = "connecting" | "open" | "retrying";

/**
 * Ouvre un flux GET qui reste ouvert, et se reconnecte après une coupure
 * (le serveur renvoie l'état courant à chaque connexion).
 */
export function openLiveStream(
  path: string,
  onMessage: (m: SSEMessage) => void,
  onStatus: (s: StreamStatus) => void,
): () => void {
  const controller = new AbortController();
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async () => {
    onStatus(attempt === 0 ? "connecting" : "retrying");
    try {
      const res = await request(path, { headers: { accept: "text/event-stream" }, cache: "no-store", signal: controller.signal });
      onStatus("open");
      attempt = 0;
      await readSSE(res, onMessage, controller.signal);
    } catch {
      /* coupure ou erreur : on retente */
    }
    if (controller.signal.aborted) return;
    attempt += 1;
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempt - 1, 4));
    onStatus("retrying");
    timer = setTimeout(connect, delay);
  };
  void connect();

  return () => {
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}
