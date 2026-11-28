# Image de production de Chat SEO. Préparée le 28 novembre 2026, JAMAIS construite ni essayée (pas de Docker sur
# la machine de développement) : à valider au premier déploiement.
# Aucun secret dans l'image : toutes les variables viennent de l'hébergeur.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package-lock.json* server/
COPY web/package.json web/package-lock.json* web/
RUN npm --prefix server ci && npm --prefix web ci
COPY shared shared
COPY server server
COPY web web
RUN npm --prefix web run build && npm --prefix server run build \
 && npm --prefix server prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# La base et ses sauvegardes vivent sur un disque persistant monté ici.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/server/src/index.js"]
