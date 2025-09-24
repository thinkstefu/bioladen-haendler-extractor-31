FROM apify/actor-node-playwright-chrome:20

# Build as root so npm can write node_modules, then drop privileges.
USER root
WORKDIR /usr/src/app

# Install production deps
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund --unsafe-perm

# Copy source
COPY . .

# Fix ownership and switch back to myuser for runtime
RUN chown -R myuser:myuser /usr/src/app
USER myuser

# Apify adds xvfb-run automatically. Just run Node.
CMD ["node", "main.js"]
