export const resetLinkMinutes = 30;

export function resetDelivery(env) {
  if (!URL.canParse(env.CLIENT_ORIGIN)) return null;
  const client = new URL(env.CLIENT_ORIGIN);
  const local = env.PASSWORD_RESET_MODE === 'local' &&
    ['http:', 'https:'].includes(client.protocol) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(client.hostname);
  if (!local && (client.protocol !== 'https:' || !env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM)) return null;

  return {
    mode: local ? 'local' : 'email',
    async send(email, token) {
      const link = new URL('/', client);
      link.hash = 'reset-password=' + token;
      if (local) {
        console.log('Password reset link (local): ' + link.href);
        return;
      }
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.PASSWORD_RESET_FROM,
          to: [email],
          subject: 'Reset your TicketMaestro password',
          text: `Set a new password using this link within ${resetLinkMinutes} minutes:\n\n${link.href}\n\nIf you did not request this, you can ignore this email.`
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw new Error('Password reset email delivery failed.');
    }
  };
}
