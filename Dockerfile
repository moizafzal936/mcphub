# MCPHub: API server + built dashboard in one image.
# Run: docker run -p 3001:3001 -v mcphub-data:/data \
#        -e MCPHUB_ENCRYPTION_KEY=... -e MCPHUB_PUBLIC_URL=https://your.domain -e MCPHUB_TRUST_PROXY=1 mcphub
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci
COPY packages ./packages
RUN npm run build && npm prune --omit=dev && mkdir -p packages/server/node_modules

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3001 MCPHUB_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/server/package.json ./packages/server/
# Workspace-local deps (e.g. ipaddr.js v2, which the SSRF guard needs; Express pulls in v1 at the root).
COPY --from=build /app/packages/server/node_modules ./packages/server/node_modules
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/dashboard/dist ./packages/dashboard/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/index.js"]
