import { env, waitUntil } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from './app.js';

// Start the Express app on the internal port used by the Cloudflare Node HTTP adapter.
createApp(env, waitUntil).listen(3000);
// Forward incoming Worker requests to the Express listener on the same port.
export default httpServerHandler({ port: 3000 });
