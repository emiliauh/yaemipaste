FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_PASTE_API=/api
ARG VITE_AUTH_API=/auth
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_PASTE_API=$VITE_PASTE_API
ENV VITE_AUTH_API=$VITE_AUTH_API
ENV VITE_TURNSTILE_SITE_KEY=$VITE_TURNSTILE_SITE_KEY

RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
