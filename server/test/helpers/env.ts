/** Monte une application complète (base en mémoire) pour les tests. */
import { createApp } from "../../src/app.ts";
import type { ChatClient } from "../../src/chat/assistant.ts";
import type { SearchProvider } from "../../src/competitors/competitors.ts";
import type { Config } from "../../src/config.ts";
import { Crawler } from "../../src/crawl/crawler.ts";
import { openDb } from "../../src/db.ts";
import { EventHub } from "../../src/events.ts";
import { Store } from "../../src/store.ts";

export function testEnv(opts: { chatClient?: ChatClient | null; searchProvider?: SearchProvider | null; delayMs?: number } = {}) {
  const config: Config = {
    port: 0,
    dataDir: ":memory:",
    anthropicApiKey: opts.chatClient ? "sk-ant-test-SECRET-KEY" : null,
    anthropicModel: "claude-sonnet-5-5",
    firecrawlApiKey: opts.searchProvider ? "fc-test" : null,
    allowPrivateHosts: true,
    version: "0.1.0",
    webDist: "/nonexistent",
  };
  const store = new Store(openDb(":memory:"));
  const hub = new EventHub();
  const crawler = new Crawler(store, hub, { concurrency: 3, delayMs: opts.delayMs ?? 20, pageTimeoutMs: 5000, maxPageBytes: 5 * 1024 * 1024 });
  const app = createApp({ config, store, hub, crawler, chatClient: opts.chatClient ?? null, searchProvider: opts.searchProvider ?? null });
  return { app, store, hub, crawler, config };
}

/** Lit un flux SSE complet et renvoie les événements { event, data }. */
export async function readSse(res: Response, until?: (ev: { event: string; data: any }) => boolean): Promise<Array<{ event: string; data: any }>> {
  const out: Array<{ event: string; data: any }> = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (!event || data === undefined) continue;
      const ev = { event, data: JSON.parse(data) };
      out.push(ev);
      if (until?.(ev)) {
        await reader.cancel();
        return out;
      }
    }
  }
  return out;
}
