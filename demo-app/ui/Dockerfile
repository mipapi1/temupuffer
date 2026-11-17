# The search UI: a static React build served by nginx, which also proxies /api/*
# to the search API (so the browser never needs CORS or the database API key).
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV SEARCH_API=search-api:8090 \
    NGINX_ENVSUBST_FILTER=SEARCH_API
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/dist /usr/share/nginx/html
EXPOSE 8080
