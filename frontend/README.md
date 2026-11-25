# TicketMaestro client

The client is a static Cloudflare Worker that calls the Express API on a separate origin. It provides customer, staff, and administrator workspaces.

## Run locally

Start the [local API and seed the demo accounts](../backend/README.md). From this directory, use the Wrangler installed in `backend` to start the client.

```powershell
../backend/node_modules/.bin/wrangler.cmd dev --port 8788
```

On macOS or Linux, omit `.cmd`. Open `http://localhost:8788`. The default client configuration calls `http://localhost:8787`.

- Sign in as a customer to submit a synthetic message and view its ticket ID, priority, and status.
- Sign in as staff to open the relevant department queue. Open a ticket to see its AI result and model, or why it needs manual review. Use the filters to find a ticket and update its status, assignment, or priority.
- Sign in as an administrator to open the API usage report. Select a 7-, 30-, or 90-day period to inspect daily requests, errors, processing time, and endpoint and account activity. The same dashboard lists lifetime endpoint totals and each account’s counted calls. Each signed-in workspace shows its own free-call allowance. Use the arrow keys on the chart to explore individual days. The sidebar also opens the ticket queue, ticket statistics, and registered users. [Local admin dashboard](http://localhost:8788/#api-usage)

## Deploy

Set the API Worker’s HTTPS origin in `public/config.js` and in the `connect-src` directive in `public/_headers`. From this directory, run `../backend/node_modules/.bin/wrangler.cmd deploy` in PowerShell. Configure the API Worker’s `CLIENT_ORIGIN` to match the deployed client’s exact HTTPS origin, omitting the trailing slash. Check sign-in and reload in your target browser. For browsers that block cross-site cookies, host the client and API on two HTTPS subdomains of the same site. [Cloudflare Static Assets documentation](https://developers.cloudflare.com/workers/static-assets/get-started/)
