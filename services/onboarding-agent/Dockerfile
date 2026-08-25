# The API server. It spawns runner containers via the host Docker socket, so it
# is deliberately thin — no toolchains, no client code ever touches it.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
# The docker CLI only; the daemon is the host's, reached through the mounted
# socket. See docker-compose.onboard.yml for why that trade-off is called out.
RUN apt-get update \
 && apt-get install -y --no-install-recommends docker.io ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY src/public ./dist/public
EXPOSE 8100
CMD ["node", "dist/server.js"]
