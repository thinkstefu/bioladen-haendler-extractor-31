# Robust Dockerfile to avoid EACCES during npm install on Apify
# Uses prebuilt image with Playwright + Chrome already installed
FROM apify/actor-node-playwright-chrome:20

# Work as root during dependency install to avoid permission issues
USER root
WORKDIR /usr/src/app

# Copy only manifests first for better layer caching
COPY package*.json ./

# Install production deps; --unsafe-perm to allow postinstall if any
# Do NOT run 'playwright install' — browsers are already present in the base image
RUN mkdir -p /usr/src/app \
 && chown -R root:root /usr/src/app \
 && (npm install --omit=dev --omit=optional --no-audit --no-fund --unsafe-perm || \
     npm install --only=prod --omit=optional --no-audit --no-fund --unsafe-perm)

# Copy the rest of the project
COPY . .

# Hand back ownership to the default Apify user
RUN chown -R myuser:myuser /usr/src/app

# Drop privileges
USER myuser

# Start your actor (expects main.js at project root)
CMD ["node", "main.js"]
