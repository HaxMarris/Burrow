FROM node:25-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/src ./server/src
COPY client ./client
ENV PORT=3000 DB_FILE=/data/chat.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
# Docker marks Peiskos unhealthy (and an uptime monitor can tell) if it stops answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/api/health || exit 1
USER node
CMD ["node", "--no-warnings", "server/src/index.ts"]
