import { ResetDelivery, resetLinkMinutes } from './reset-delivery-base.js';

export class EmailResetDelivery extends ResetDelivery {
  mode = 'email';
  #env;

  // Use the deployment's verified sender and server-side credential for delivery.
  constructor(client, env) {
    super(client);
    this.#env = env;
  }

  // Send the expiring link to the account address. Network and provider errors
  // reject the promise so the request handler can record a delivery failure.
  async send(email, token) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.#env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: this.#env.PASSWORD_RESET_FROM,
        to: [email],
        subject: 'Reset your TicketMaestro password',
        text: `Set a new password using this link within ${resetLinkMinutes} minutes:\n\n${this.linkFor(token)}\n\nIf you did not request this, you can ignore this email.`
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('Password reset email delivery failed.');
  }
}
