# CSS + Mashlib + this repo's config, nothing else.
#
# CSS is built from a git ref rather than npm because the fixes solidcommunity.net needs
# are on CSS main but not yet in a release (7.2.0 predates them). Once a release contains
# them, swap the builder stage for a plain npm dependency.
ARG CSS_REPO=https://github.com/CommunitySolidServer/CommunitySolidServer.git
ARG CSS_REF=3cd2aca2d6b8815204520e272d6e5b0b4d7a6071

FROM node:22-bookworm-slim AS css
ARG CSS_REPO
ARG CSS_REF
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init -q . && git remote add origin "$CSS_REPO" \
 && git fetch -q --depth 1 origin "$CSS_REF" && git checkout -q FETCH_HEAD
RUN npm ci --ignore-scripts && npm run build && mkdir /out && npm pack --ignore-scripts --pack-destination /out

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY --from=css /out/*.tgz /tmp/css.tgz
RUN npm ci --omit=dev --ignore-scripts \
 && npm install --omit=dev --ignore-scripts --no-save /tmp/css.tgz \
 && rm /tmp/css.tgz && npm cache clean --force
COPY config ./config
COPY templates ./templates
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
