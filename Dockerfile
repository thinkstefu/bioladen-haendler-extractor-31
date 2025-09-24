# Apify + Playwright (Chrome) — browser already preinstalled
FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app
USER root

# Install only production deps
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy source
COPY . .

# Ensure permissions
RUN chown -R myuser:myuser /usr/src/app
USER myuser

# Default start command (Apify adds xvfb-run automatically in UI, but this is safe)
CMD ["node", "main.js"]
