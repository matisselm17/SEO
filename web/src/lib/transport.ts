/**
 * Point unique par lequel passent toutes les requêtes vers /api.
 * En production, c'est fetch. En développement avec VITE_DEMO=1, le mode démonstration
 * remplace fetch par un faux serveur. La condition `import.meta.env.DEV` est remplacée
 * par `false` à la compilation de production : le mode démo est alors retiré du build.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Mode démonstration : `vite --mode demo` (script dev:demo) ou VITE_DEMO=1, en développement uniquement. */
export const DEMO_ENABLED: boolean = import.meta.env.DEV && (import.meta.env.MODE === "demo" || import.meta.env.VITE_DEMO === "1");

let impl: FetchLike = (input, init) => fetch(input, init);
let ready: Promise<void> = Promise.resolve();

if (import.meta.env.DEV && (import.meta.env.MODE === "demo" || import.meta.env.VITE_DEMO === "1")) {
  // En démonstration, jamais de repli sur fetch : si le faux serveur ne charge pas, toute requête échoue.
  impl = () => Promise.reject(new Error("Mode démonstration : faux serveur non chargé, aucun appel réseau réel."));
  ready = import("../demo/server").then((m) => {
    impl = m.demoFetch;
  });
}

export async function transport(input: string, init?: RequestInit): Promise<Response> {
  await ready;
  return impl(input, init);
}
