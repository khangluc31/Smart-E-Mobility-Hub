import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app';
import { config } from './core/config';

const app = createApp();

app.listen(config.PORT, () => {
  console.log(`[server] listening on http://localhost:${config.PORT}`);
  console.log(`[server] JOBS_ENABLED=${config.JOBS_ENABLED}`);
  // Jobs are not started yet (T-03)
});
