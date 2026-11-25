import { fileURLToPath } from 'node:url';
import { openApi } from './openapi.js';

export const swaggerFiles = ['swagger-ui-bundle.js', 'swagger-ui.css', 'swagger-ui-bundle.js.LICENSE.txt', 'LICENSE', 'NOTICE'];

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TicketMaestro API documentation</title>
  <link rel="stylesheet" href="/doc/assets/swagger-ui.css">
</head>
<body>
  <main id="swagger-ui"><a href="/doc/openapi.json">TicketMaestro OpenAPI specification</a></main>
  <script src="/doc/assets/swagger-ui-bundle.js"></script>
  <script src="/doc/start.js"></script>
</body>
</html>`;

export function registerDocumentation(app) {
  app.get('/doc/', (_req, res) => res.set({
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff'
  }).type('html').send(page));
  app.get('/doc/openapi.json', (_req, res) => res.json(openApi));
  app.get('/doc/start.js', (_req, res) => res.type('application/javascript').send(
    "SwaggerUIBundle({url:'/doc/openapi.json',dom_id:'#swagger-ui',deepLinking:true,withCredentials:true,validatorUrl:null});"
  ));
  // Wrangler serves these files directly as static assets. Native Node (dev:ai and tests)
  // serves the same locked distribution from the backend's dependency directory.
  app.get('/doc/assets/:file', (req, res, next) => {
    if (!swaggerFiles.includes(req.params.file)) return next();
    const root = fileURLToPath(new URL('../node_modules/swagger-ui-dist/', import.meta.url));
    res.sendFile(req.params.file, { root });
  });
}
