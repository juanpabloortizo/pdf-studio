FROM node:20-slim

# Librerias del sistema: Chromium (headless) + toolchain para compilar
# better-sqlite3 si no hubiera binario prebuilt para la arquitectura.
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip ca-certificates python3 make g++ \
    fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libc6 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libgcc-s1 \
    libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 \
    libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 \
    libxdamage1 libxext6 libxfixes3 libxi6 libxkbcommon0 libxrandr2 \
    libxrender1 libxshmfence1 libxss1 libxtst6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala deps sin bajar Chromium en este paso...
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev

# ...y baja el Chromium de puppeteer una sola vez, a la cache por defecto
RUN npx puppeteer browsers install chrome

COPY . .
EXPOSE 8088
CMD ["node", "server.js"]
