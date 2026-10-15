import { config } from './config.js';
import { createApp } from './app.js';

const { app, scheduler } = createApp(config);
app.listen(config.port, () => {
  console.log(`OpenEnvelope server on ${config.baseUrl} (port ${config.port})`);
  scheduler.start();
});
