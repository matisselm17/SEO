# Chat SEO

Un logiciel SEO qui connaît votre site : indiquez son adresse, suivez l'analyse en direct, lisez la note, les problèmes expliqués avec leurs preuves et les actions prioritaires, puis posez vos questions à l'assistant.

## Lancer en développement

```bash
npm install
cp .env.example .env   # puis compléter les clés facultatives
npm run dev
```

L'interface s'ouvre sur http://localhost:5173, le serveur écoute sur http://localhost:8787.

## Lancer en production

```bash
npm install
npm run build
npm start
```

Le serveur sert l'interface compilée sur le port `PORT`.

## Organisation

- `server/` — le moteur : parcours des sites, notation, import Search Console, assistant.
- `web/` — l'interface.
- `shared/api.ts` et `docs/format-echange.md` — le format d'échange entre les deux.
- `CLAUDE.md` — les règles du projet et l'équipe d'agents.
