import { LocalResetDelivery } from './local-reset-delivery.js';
import { EmailResetDelivery } from './email-reset-delivery.js';

export { resetLinkMinutes } from './reset-delivery-base.js';

// Select password-reset delivery based on the client URL and environment settings.
// Return local logging for an explicitly enabled loopback client, hosted email for a configured HTTPS client,
// or null when delivery is unavailable.
export function resetDelivery(env) {
  if (!URL.canParse(env.CLIENT_ORIGIN)) return null;
  const client = new URL(env.CLIENT_ORIGIN);
  const local = env.PASSWORD_RESET_MODE === 'local' &&
    ['http:', 'https:'].includes(client.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(client.hostname);
  if (local) return new LocalResetDelivery(client);
  if (client.protocol !== 'https:' || !env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM) return null;
  return new EmailResetDelivery(client, env);
}
