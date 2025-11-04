# preview-host/Dockerfile
FROM node:22-alpine

# system tools
RUN apk add --no-cache bash git
RUN npm i -g pnpm@9

# caches & working dirs
RUN mkdir -p /srv/.pnpm-store /srv/previews /srv/orchestrator
ENV PNPM_STORE_DIR=/srv/.pnpm-store

WORKDIR /srv

# ---- (A) Bring in your boilerplate (public GitHub) ----
ARG BOILERPLATE_REPO="https://github.com/Nemil21/minidev-boilerplate.git"
ARG BOILERPLATE_REF="main"     # or pin a commit SHA
RUN git clone --filter=blob:none --depth=1 -b "$BOILERPLATE_REF" "$BOILERPLATE_REPO" /srv/boilerplate
# Prewarm pnpm store for the boilerplate to speed installs at runtime
RUN cd /srv/boilerplate && pnpm fetch

# ---- (B) Install orchestrator deps (this was missing) ----
# Copy only manifest first for layer caching
COPY orchestrator/package.json /srv/orchestrator/package.json
# (optional but recommended) if you have a lockfile, copy it too:
# COPY orchestrator/pnpm-lock.yaml /srv/orchestrator/pnpm-lock.yaml
RUN pnpm --dir /srv/orchestrator install --prod --prefer-offline --store-dir /srv/.pnpm-store

# Now copy the orchestrator source
COPY orchestrator/ /srv/orchestrator/

# Start the orchestrator
WORKDIR /srv/orchestrator
EXPOSE 8080
CMD ["node", "index.js"]
