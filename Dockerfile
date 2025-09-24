FROM apify/actor-node-playwright-chrome:20

USER root
WORKDIR /usr/src/app
RUN mkdir -p /usr/src/app && chown -R myuser:myuser /usr/src/app

ENV NPM_CONFIG_CACHE=/home/myuser/.npm
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY --chown=myuser:myuser package*.json ./
USER myuser
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund || \
    npm install --omit=dev --omit=optional --no-audit --no-fund

COPY --chown=myuser:myuser . .

CMD ["node", "main.js"]
