# TicketMaestro API

The Express Worker validates ticket submissions, requests an AI classification, and writes the ticket and usage record to D1. Staff can search departmental queues, review uncertain tickets, and change routing, priority, and status.

## Local API and demo data

Use Node.js 22.14 or newer. From `backend`, run the following in PowerShell.

```powershell
npm.cmd ci
npm.cmd run db:local
node scripts/demo-sql.js --tickets | Set-Content -Encoding ascii .wrangler/demo.sql
npx.cmd wrangler d1 execute DB --local --file .wrangler/demo.sql
npm.cmd run dev
```

On macOS or Linux, use `npm` and `npx` in place of `npm.cmd` and `npx.cmd`, and use `node scripts/demo-sql.js --tickets > .wrangler/demo.sql` to write the seed file.

The API runs at `http://localhost:8787`. Running `npm run dev` uses local D1 and queues new submissions for manual review. For live inference with local D1, authenticate Wrangler with `npx wrangler login` and run `npm run dev:ai` in place of `npm run dev`.

Clef Flash (`@cf/cloudflare/clef-flash`) is the default. Its inference uses the Workers AI free daily allocation while quota is available. To select TypeSafe Jev for local development, run `npm run dev:ai -- --var AI_MODEL:typesafe/jev`. Jev uses third-party AI Gateway billing. [Clef Flash documentation](https://developers.cloudflare.com/workers-ai/models/clef-flash/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [AI Gateway billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

The seed can be rerun. It preserves existing account passwords, roles, tickets, and staff assignments. Omit `--tickets` to seed accounts only. Sample tickets exercise all four queues and manual review. Their classification outcome is recorded as `seeded`.

| Role | Email | Local demo password |
| --- | --- | --- |
| Customer | `john@john.com` | `123` |
| Administrator | `admin@admin.com` | `111` |
| Billing staff | `billing@example.test` | `NorthLink-demo-only-Workshop42!` |
| Technical staff | `technical@example.test` | `NorthLink-demo-only-Workshop42!` |
| Account staff | `account@example.test` | `NorthLink-demo-only-Workshop42!` |
| General Support staff | `general@example.test` | `NorthLink-demo-only-Workshop42!` |

Use these defaults in an isolated synthetic demo. For a hosted account seed, provide distinct private values through the shell environment using `TICKETMAESTRO_DEMO_CUSTOMER_PASSWORD`, `TICKETMAESTRO_DEMO_ADMIN_PASSWORD`, and `TICKETMAESTRO_DEMO_STAFF_PASSWORD` before generating SQL. The staff override applies to the four demo staff accounts. The generator writes only password hashes. Keep the SQL file out of version control.

## Cloudflare deployment

1. Authenticate Wrangler to the team’s Cloudflare account with `npx wrangler login`. A CI environment can use provider credentials in its secret store. The account needs permission to manage Workers and D1 and use Workers AI, along with sufficient Worker CPU for scrypt.
2. Run `npx wrangler d1 create ticketmaestro` in `backend` to create the remote database. Use the returned name and database ID in the `DB` binding in `wrangler.toml`. Set `CLIENT_ORIGIN` to the client Worker’s exact HTTPS origin without a trailing slash. The `AI_MODEL` variable defaults to `@cf/cloudflare/clef-flash`. Set it to `typesafe/jev` if deploying with Jev. [D1 CLI documentation](https://developers.cloudflare.com/workers/wrangler/commands/d1/)
3. Run `npm run db:remote` before deploying new code. To populate a dedicated synthetic demo database with accounts, create `.wrangler` if needed, generate the seed SQL with private passwords, and run `npx wrangler d1 execute DB --remote --file .wrangler/demo.sql`. Use `--tickets` only if you want the prewritten examples.
4. Run `npm run deploy`, then set the client to the returned API URL as described in the [client setup](../frontend/README.md). The Workers AI binding handles provider access from the API.
5. Request `/api/health` from the hosted API. Sign in through the deployed client and submit a fresh synthetic outage. As staff, open the ticket to check the model, suggested department, and urgency. If the ticket routed to Technical, find it in that queue, change its status, and reload both workspaces to verify persistence.
