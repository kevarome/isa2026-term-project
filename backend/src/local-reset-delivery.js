import { ResetDelivery } from './reset-delivery-base.js';

export class LocalResetDelivery extends ResetDelivery {
  mode = 'local';

  // Local development exposes the reset link in the API console for the developer.
  async send(_email, token) {
    console.log('Password reset link (local): ' + this.linkFor(token));
  }
}
