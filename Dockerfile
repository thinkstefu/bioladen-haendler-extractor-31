FROM apify/actor-node-playwright-chrome:20

# Work as root for install to avoid EACCES issues, then drop back to myuser
USER root
WORKDIR /usr/src/app

# Install production deps (no npm ci -> no lockfile requirement)
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund

# Copy source and set permissions
COPY . .
RUN chown -R myuser:myuser /usr/src/app

# Drop privileges
USER myuser

# Default command; Apify overrides with xvfb-run automatically
CMD ["node", "main.js"]
