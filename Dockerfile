# Build autônomo do projeto api/: docker build -t anubis-api ./api
# O VSIX está em api/extension/ e é servido por /admin/extension/*.
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY extension ./extension/
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/models').then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
