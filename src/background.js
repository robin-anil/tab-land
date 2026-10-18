// Tab Land — MV3 service worker entry. All behavior lives in src/bg/*; this file only injects the real APIs.
import { createApp } from './bg/app.js';

const app = createApp({ chrome, fetch: (input, init) => fetch(input, init) });
app.attach();
