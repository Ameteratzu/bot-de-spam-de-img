FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY assets/fonts/Inter.ttf /usr/local/share/fonts/truetype/inter/Inter.ttf
RUN fc-cache -f

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /app/data /app/generated && chown -R node:node /app/data /app/generated

ENV NODE_ENV=production \
    PORT=3000

USER node
EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
