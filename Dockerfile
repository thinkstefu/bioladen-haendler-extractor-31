# Stable Apify base image with Playwright + Chrome preinstalled
FROM apify/actor-node-playwright-chrome:20

# Workdir
WORKDIR /usr/src/app

# Copy package manifests first (better layer caching)
COPY package*.json ./

# Install dependencies as root to avoid EACCES, then drop privileges
USER root
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy the rest of the source
COPY . .

# Fix ownership for runtime
RUN chown -R myuser:myuser /usr/src/app

# Switch to non-root user
USER myuser

# Default command
CMD ["node", "main.js"]