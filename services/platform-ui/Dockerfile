# Read-only UI over the platform's own backends. No Docker socket, no
# credentials, no write path - unlike the onboarding agent next door, which
# needs all three.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund
# dist/public is produced by `npm run build`, so it comes with dist.
COPY --from=build /app/dist ./dist
EXPOSE 8200
CMD ["node", "dist/server.js"]
