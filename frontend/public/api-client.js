import { messages } from './messages.js';

export class ApiClient {
  #origin;
  #onSessionExpired;
  #onUsage;
  #revision = 0;

  constructor(origin, onSessionExpired, onUsage) {
    this.#origin = origin;
    this.#onSessionExpired = onSessionExpired;
    this.#onUsage = onUsage;
  }

  // A local revision lets views discard late responses after login or logout.
  get sessionRevision() {
    return this.#revision;
  }

  changeSession() {
    this.#revision++;
  }

  async request(path, body, method = body === undefined ? 'GET' : 'POST') {
    const revision = this.#revision;
    const response = await fetch(this.#origin + '/api/v1' + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 401 && revision === this.#revision && path !== '/auth/login') {
      this.changeSession();
      this.#onSessionExpired();
    }
    if (revision === this.#revision) this.#onUsage?.(response.headers);
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      throw Object.assign(new Error(result?.error || messages.requestFailed), { status: response.status });
    }
    return result;
  }
}
