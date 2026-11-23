export const resetLinkMinutes = 30;

// Both delivery methods build the same client-side link. Keeping the token in the
// fragment lets the browser read it without sending it in the initial HTTP request.
export class ResetDelivery {
  #client;

  // Use the configured client origin so the recipient opens the correct deployment.
  constructor(client) {
    this.#client = client;
  }

  // Construct a fresh URL for each recipient's single-use reset token.
  linkFor(token) {
    const link = new URL('/', this.#client);
    link.hash = 'reset-password=' + token;
    return link.href;
  }
}
