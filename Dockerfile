# Build com contexto na raiz do monorepo: docker build -f api/Dockerfile -t anubis-api .
# O contexto é a raiz porque o artefato da extensão fica em extension/ e é servido pela API.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
WORKDIR /app
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api/src ./src
COPY extension/*.vsix ./extension/
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/models').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
