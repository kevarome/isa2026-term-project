# TicketMaestro

TicketMaestro is a support portal for NorthLink Internet, a fictional internet provider. It uses AI to identify the support department and urgency of a request. Requests with uncertain results go to manual review.

- AI provider and model. Cloudflare Workers AI. This repository configures Cloudflare Clef Flash by default and supports TypeSafe Jev through the `AI_MODEL` variable. The staff ticket view shows which model handled a submission.
- Registration and sign-in. [Open TicketMaestro](https://ticketmaestro-client.kevyn-anthoni.workers.dev)
- Administrator access. Sign in with the administrator account to see endpoint totals and each user's API consumption. [Open TicketMaestro](https://ticketmaestro-client.kevyn-anthoni.workers.dev)
- AI demonstration. [Open TicketMaestro](https://ticketmaestro-client.kevyn-anthoni.workers.dev), sign in as the demo user, select the outage example, and submit the ticket. Open the saved ticket as staff to see its model and classification.

The accounts below use the local demo seed. Use the privately configured credentials for the hosted demonstration.

| Role | Email | Local demo password |
| --- | --- | --- |
| User | john@john.com | 123 |
| Administrator | admin@admin.com | 111 |

The Milestone 2 API reference is served at `/doc/` on the API Worker.
