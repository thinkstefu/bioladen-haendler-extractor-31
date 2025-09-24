FROM apify/actor-node-playwright-chrome:20

# Work as root for install, then drop privileges
USER root
WORKDIR /usr/src/app

# Install prod deps (no npm ci to avoid lockfile requirement)
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy source
COPY . .

# Ensure runtime user owns files
RUN chown -R myuser:myuser /usr/src/app
USER myuser

# Default command
CMD ["node", "main.js"]
