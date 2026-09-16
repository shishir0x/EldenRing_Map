FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Run icon sync if needed
RUN node scripts/download_icons.js || true

ENV NODE_ENV=production
ENV PORT=3000
ENV CACHE_MAX_SIZE_MB=500
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
