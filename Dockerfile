# Robust image with Chrome + Playwright preinstalled
FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

# Install only prod deps as root to avoid EACCES during build
USER root
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy source and hand over ownership to myuser
COPY . .
RUN chown -R myuser:myuser /usr/src/app

USER myuser
CMD ["node", "main.js"]
