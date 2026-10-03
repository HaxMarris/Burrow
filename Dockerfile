FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server/src ./server/src
COPY client ./client
ENV PORT=3000 DB_FILE=/data/chat.db NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server/src/index.ts"]
