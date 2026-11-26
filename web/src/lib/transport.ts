/**
 * Point unique par lequel passent toutes les requêtes vers /api.
 * En production, c'est fetch. En développement avec VITE_DEMO=1, le mode démonstration
 * remplace fetch par un faux serveur. La condition `import.meta.env.DEV` est remplacée
 * par `false` à la compilation de production : le mode démo est alors retiré du build.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let impl: FetchLike = (input, init) => fetch(input, init);
let ready: Promise<void> = Promise.resolve();

export const DEMO_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_DEMO === "1";

if (import.meta.env.DEV && import.meta.env.VITE_DEMO === "1") {
  ready = import("../demo/server").then((m) => {
    impl = m.demoFetch;
  });
}

export async function transport(input: string, init?: RequestInit): Promise<Response> {
  await ready;
  return impl(input, init);
}
