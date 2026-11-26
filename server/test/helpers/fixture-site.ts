/**
 * Petit site d'essai servi en local (plusieurs pages avec des défauts variés), pour les tests
 * et la vérification de bout en bout. Utilisé uniquement avec ALLOW_PRIVATE_HOSTS / setAllowPrivateHosts(true).
 * Lancement manuel : `npx tsx test/helpers/fixture-site.ts 8790`
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/site");

export interface FixtureSite {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

export function startFixtureSite(port = 0, opts: { slowMs?: number } = {}): Promise<FixtureSite> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push(url.pathname + url.search);
    const origin = `http://${req.headers.host}`;
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    const go = () => {
      const p = url.pathname;
      if (p === "/old") return send(301, "text/plain", "", { location: "/services" });
      if (p === "/to-internal") return send(302, "text/plain", "", { location: "http://127.0.0.1:9/secret" });
      if (p === "/missing") return send(404, "text/html", "<h1>Introuvable</h1>");
      if (p === "/doc.pdf") return send(200, "application/pdf", "%PDF-1.4");
      if (p === "/robots.txt" || p === "/sitemap.xml") {
        const text = readFileSync(path.join(ROOT, p.slice(1)), "utf8").replaceAll("{{ORIGIN}}", origin);
        return send(200, p.endsWith(".xml") ? "application/xml" : "text/plain", text);
      }
      const name = p === "/" ? "index.html" : p.replace(/\/$/, "").slice(1) + ".html";
      const file = path.resolve(ROOT, name);
      if (file.startsWith(ROOT) && existsSync(file)) return send(200, "text/html; charset=utf-8", readFileSync(file));
      send(404, "text/html", "<h1>Introuvable</h1>");
    };
    if (opts.slowMs) setTimeout(go, opts.slowMs);
    else go();
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        origin: `http://localhost:${addr.port}`,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8790);
  void startFixtureSite(port).then((s) => console.log(`Site d'essai sur ${s.origin}`));
}
