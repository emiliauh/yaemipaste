# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.runtime.json ./
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:runtime && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
RUN mkdir -p /var/lib/yaemipaste/upload /var/lib/yaemipaste-auth
EXPOSE 8000
CMD ["node", "dist/src/main.js"]
