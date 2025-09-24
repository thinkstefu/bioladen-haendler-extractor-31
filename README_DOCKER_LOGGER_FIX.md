# Bioladen Händler Extractor — Docker/Logger Fix

This drop-in patch fixes:
- `EACCES: permission denied, mkdir '/usr/src/app/node_modules'` during build
- Double `xvfb-run` in run command
- `Cannot read properties of undefined (reading 'info')` by providing a safe `logger` fallback

## What to do

1) **Add or replace** these files in your repo root:
   - `Dockerfile` (from this ZIP)
   - `.dockerignore` (from this ZIP)
   - `package.json` (from this ZIP) — keep your existing dependencies if you had others, just ensure `scripts.start` is `node main.js` and keep `"type": "module"` if your code uses ESM.

2) Open your `main.js` and at the VERY TOP add the following lines (before you use `log.*`):
```js
import Apify, { log as apifyLog } from 'apify';

// Safe logger fallback (prevents "Cannot read properties of undefined (reading 'info')")
const log = apifyLog ?? (Apify?.utils?.log) ?? {
  info: (...a) => console.log('[INFO]', ...a),
  warning: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
  debug: (...a) => console.debug('[DEBUG]', ...a),
};
```

If you previously had `const { log } = Apify.utils;` or `Apify.utils.log`, **remove it**.

3) In Apify console: **do not** prepend your command with `xvfb-run`. The platform already wraps it.
   - Your build should run with this image and your run command should effectively be `node main.js`.
   - If you see `xvfb-run ... xvfb-run ...`, remove any custom xvfb you added in `Dockerfile`, `package.json`, or Actor **Run options**.

## Notes

- The base image `apify/actor-node-playwright-chrome:20` already contains Playwright browsers, so there's no `postinstall` download step and no `ENOENT` for Chromium.
- If you have extra dependencies, merge them into this `package.json` before building.
