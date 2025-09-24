FROM apify/actor-node-playwright-chrome:20
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --omit=dev --omit=optional --no-audit --no-fund
COPY . .
USER myuser
CMD ["node", "main.js"]
