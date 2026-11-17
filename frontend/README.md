# TicketMaestro client

The client is a static Cloudflare Worker that calls the Express API on a separate origin. It provides customer, staff, and administrator workspaces.

## Run locally

Start the [local API and seed the demo accounts](../backend/README.md). From this directory, use the Wrangler installed in `backend` to start the client.

```powershell
../backend/node_modules/.bin/wrangler.cmd dev --port 8788
```

On macOS or Linux, omit `.cmd`. Open `http://localhost:8788`. The default client configuration calls `http://localhost:8787`.

- Sign in as a customer to submit a synthetic message and view its ticket ID, priority, and status.
- Sign in as staff to open the relevant department queue. Use the filters to find a ticket and update its status, assignment, or priority. The review queue includes submissions that need a human routing decision.
- Sign in as an administrator to manage the support queue, review ticket statistics, and view registered users.

## Deploy

Set the API Worker’s HTTPS origin in `public/config.js` and in the `connect-src` directive in `public/_headers`. From this directory, run `../backend/node_modules/.bin/wrangler.cmd deploy` in PowerShell. Configure the API Worker’s `CLIENT_ORIGIN` to match the deployed client’s exact HTTPS origin, omitting the trailing slash. [Cloudflare Static Assets documentation](https://developers.cloudflare.com/workers/static-assets/get-started/)
