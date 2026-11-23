# The throwaway machine an app is built in. It holds none of the instance's credentials: the
# instance hands it the app's source and, for the app alone, its database address and a one-hour
# token for uploading its static files; the instance itself provisions and deploys.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && mkdir -p /work && chown node:node /work
WORKDIR /builder
COPY server.mjs .
# Not root: some builds and tests, such as an embedded Postgres, refuse to run as root.
USER node
ENV CI=1
EXPOSE 8080
CMD ["node", "server.mjs"]
