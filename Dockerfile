FROM apify/actor-node-playwright-chrome:20

# Workdir
WORKDIR /usr/src/app

# Copy package manifests first (better layer caching)
COPY package*.json ./

# Install production deps (as root allowed in this image), then switch to myuser
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy rest
COPY . .

# Ensure permissions for non-root user
RUN chown -R myuser:myuser /usr/src/app

USER myuser

# Default command (Apify adds its own xvfb wrapper; we keep it simple)
CMD ["node", "main.js"]
