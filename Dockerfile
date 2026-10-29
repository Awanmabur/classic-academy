FROM node:24.11.1-bookworm-slim

ENV NODE_ENV=production \
    PORT=3300

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 3300

HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=45s \
  --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://127.0.0.1:3300/healthz',res=>{res.resume();process.exit(res.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})"

CMD ["npm", "start"]
