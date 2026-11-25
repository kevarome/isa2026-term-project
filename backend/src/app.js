import { messages } from './messages.js';
import express from 'express';
import { AuthController } from './auth.js';
import { AdminController } from './admin.js';
import { TicketController } from './tickets.js';
import { ApiUsage } from './usage.js';
import { registerDocumentation } from './documentation.js';

// Create and return the Express application with the supplied Worker bindings.
// The optional waitUntil callback lets hosted password-reset email finish after the response.
export function createApp(env, waitUntil) {
  const app = express();
  const db = env.DB;
  const usage = new ApiUsage(db);
  const auth = new AuthController(env, waitUntil);
  const tickets = new TicketController(env);
  const admin = new AdminController(db);

  app.disable('x-powered-by');
  app.use(usage.track);
  // Disable caching and enforce the configured browser origin.
  // For allowed origins, provide CORS headers and answer preflight requests immediately.
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store').vary('Origin');
    const origin = req.get('Origin');
    // Swagger UI runs on the API's own origin. Browser requests from the client
    // use its exact configured origin. Reject cross-site writes lacking an Origin.
    const apiHost = req.get('Host');
    const sameOrigin = origin === 'https://' + apiHost || (req.protocol === 'http' && origin === 'http://' + apiHost);
    if ((origin && origin !== env.CLIENT_ORIGIN && !sameOrigin) ||
        (!origin && req.get('Sec-Fetch-Site') === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))) {
      return res.status(403).json({ error: messages.originDenied });
    }
    if (origin) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true'
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  // Run a small D1 query before reporting that the API and database are available.
  const api = express.Router();
  api.get('/health', async (_req, res) => {
    await db.prepare('SELECT id FROM users LIMIT 1').first();
    res.json({ status: 'ok', database: 'connected' });
  });

  auth.registerRoutes(api, usage.consume);
  const counted = [auth.authenticate, usage.consume];
  tickets.registerRoutes(api, counted, AuthController.requireAdmin);
  admin.registerRoutes(api, counted, AuthController.requireAdmin, usage.report);
  app.use('/api/v1', api);
  app.use('/api', api);

  registerDocumentation(app);

  // Return a JSON 404 for requests that reach the end of the route list.
  app.use((_req, res) => res.status(404).json({ error: messages.endpointMissing }));
  // Convert malformed or oversized JSON errors into client responses.
  // Log the error name for unexpected failures and return a generic 500 response.
  app.use((error, _req, res, _next) => {
    if (error.status === 400 || error.status === 413) {
      return res.status(error.status).json({ error: error.status === 400 ? messages.invalidJson : messages.requestTooLarge });
    }
    console.error('Request failed', error.name);
    res.status(500).json({ error: messages.serverError });
  });
  return app;
}
