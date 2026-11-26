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

## Hosted verification

On November 25, 2026 (Pacific time), an automated Microsoft Edge session exercised the public client and API using temporary accounts and fictional tickets. The tested API revision was `cbb2646`. [Hosted client](https://ticketmaestro-client.kevyn-anthoni.workers.dev) · [Hosted API reference](https://ticketmaestro-api.kevyn-anthoni.workers.dev/doc/)

| Requirement | Observed on the hosted deployment |
| --- | --- |
| Authentication | Registration returned 201. An incorrect password returned 401. A valid login set a Secure, HttpOnly, SameSite=None cookie. The client restored the workspace after reload. A protected request after logout returned 401. |
| Authorization | A second customer received 404 when reading the first customer’s ticket and 403 when attempting to edit it or open the administrator usage report. |
| AI integration | For an office-wide outage, the staff view displayed Cloudflare Clef Flash, Technical, High urgency, and 80.5% confidence. On counted call 26, the API accepted a duplicate-charge ticket and the model suggested Billing with medium urgency. |
| Persistent CRUD | The customer created and reopened the outage ticket. An administrator marked it resolved. The customer’s independent session read the updated status. After the administrator deleted it, the detail endpoint returned 404 and a refreshed customer list omitted the ticket. |
| Free allowance | The client showed zero free calls remaining at call 20 and displayed the exhaustion warning at call 21. Login returned the same total after logout. The subsequent ticket-list request brought both the client and administrator’s user table to 22. |
| Endpoint and user totals | The dashboard listed 17 method-and-path entries. A malformed JSON body, oversized body, and unsupported charset returned 400, 413, and 415. The customer count, ticket POST count, and endpoint error count each increased by exactly three. |
