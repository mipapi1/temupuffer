# The console: a static React build served by nginx, which also proxies /api/*
# to the query nodes (so the browser never needs CORS).
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# backends.sh builds the query-node ring from QUERY_RING (or QUERY_UPSTREAM)
# at startup. The envsubst filter keeps nginx's own $variables in the template.
ENV QUERY_UPSTREAM=query:8080 \
    NGINX_ENVSUBST_FILTER=QUERY_UPSTREAM
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Runs before the envsubst step: the namespace-affinity ring, plus BACKENDS routes (see the script).
COPY --chmod=755 backends.sh /docker-entrypoint.d/15-temupuffer-backends.sh
COPY --from=build /src/dist /usr/share/nginx/html
# 8080: console + /api/.  8081: the API router (API at the root path).
EXPOSE 8080 8081
