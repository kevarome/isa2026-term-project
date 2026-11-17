# TicketMaestro client

The client is a static Cloudflare Worker. From this directory, run `npx wrangler@4 dev --port 8788` for local development or `npx wrangler@4 deploy` to host it. The API must run independently. Set its origin in `public/config.js` and in the `connect-src` directive in `public/_headers`. Use this client's origin as the API's `CLIENT_ORIGIN`.
