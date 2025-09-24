# Fixed: let Apify platform provide xvfb-run. We only run `node main.js`.
FROM apify/actor-node-playwright-chrome:20

WORKDIR /usr/src/app

# Install deps as root to avoid EACCES, then chown to myuser.
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund
COPY . .
RUN chown -R myuser:myuser /usr/src/app

USER myuser

# Apify adds xvfb-run automatically; keep the command clean.
CMD ["node", "main.js"]
