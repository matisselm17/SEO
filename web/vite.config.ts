import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const at = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Mode démonstration (`vite --mode demo`, script `npm run dev:demo`) : le faux serveur de src/demo répond
 * à tout dans le navigateur. Aucun relais vers le vrai serveur : toute requête /api qui arriverait quand même
 * au serveur de développement échoue bruyamment (503), pour qu'aucune donnée réelle ne soit lue ni écrite.
 */
function demoGuard(): Plugin {
  return {
    name: "demo-guard",
    configureServer(server) {
      server.middlewares.use("/api", (_req, res) => {
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "internal", message: "Mode démonstration : aucun appel au vrai serveur n'est permis.", action: null } }));
        console.error("[démo] requête /api bloquée : le mode démonstration ne parle jamais au vrai serveur.");
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === "demo";
  return {
  plugins: demo ? [react(), demoGuard()] : [react()],
  // Le mode démo s'active lui-même, sans dépendre d'un fichier .env ignoré par git.
  define: demo ? { "import.meta.env.VITE_DEMO": JSON.stringify("1") } : {},
  server: {
    port: 5173,
    // Le serveur de développement ne sert que le strict nécessaire : l'application, les types partagés et,
    // pour le mode démo, les exemples. Jamais la base SQLite, la sauvegarde de la boutique, les thèmes ni les
    // secrets (compte de service Google, .env) : ils sont hors de `allow` et en plus explicitement refusés.
    fs: {
      strict: true,
      allow: [at("./"), at("../shared"), at("../docs/exemples")],
      deny: [".env", ".env.*", "*.{crt,pem,key}", "**/secrets/**", "**/data/**", "**/themes/**", "**/*.sqlite*", "**/*.db", "**/.git/**"],
    },
    proxy: demo ? undefined : {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: false,
        // Flux SSE : aucune mise en tampon, aucune compression.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("accept-encoding", "identity");
          });
          proxy.on("proxyRes", (proxyRes) => {
            if (String(proxyRes.headers["content-type"] ?? "").includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
};
});
