# TicketMaestro API

Use Node.js 22.14 or newer. Run `npm ci`, `npm run db:local`, and `npm run dev` to use local D1 and the manual-review workflow. Run `npm run dev:ai` with an authenticated Cloudflare account for live Jev inference.

For deployment, create a D1 database with `npx wrangler d1 create ticketmaestro`, add its ID to `wrangler.toml`, and set `CLIENT_ORIGIN` to the client Worker's exact HTTPS origin. Run `npm run db:remote` followed by `npm run deploy`. The account needs Workers AI access to `typesafe/jev` and sufficient Worker CPU for scrypt.

To seed the grading accounts in a dedicated synthetic-data database, save the output of `node scripts/demo-sql.js` to a UTF-8 SQL file and run `npx wrangler d1 execute DB --local --file path/to/demo.sql`. Use `--remote` for the remote grading database. Seed each database once.
