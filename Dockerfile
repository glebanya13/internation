FROM node:22-slim

# Chromium нужен для рендеринга PDF списков и графиков.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY migrations ./migrations
COPY src ./src

CMD ["npx", "tsx", "src/main/worker.ts"]
