import { messages } from './messages.js';
// Manages the customer's ticket history, its page cursor, and the submission count.
export class CustomerTicketList {
  #client;
  #renderRow;
  #next = null;
  #request = 0;
  #list = document.getElementById('tickets');
  #usage = document.getElementById('usage');
  #refresh = document.getElementById('refresh-customer-tickets');
  #more = document.getElementById('more-customer-tickets');

  // Use the shared API client and accept a row renderer so ticket markup stays consistent with the rest
  // of the UI.
  constructor(client, renderRow) {
    this.#client = client;
    this.#renderRow = renderRow;
  }

  // Reset the displayed history and pagination before opening a customer workspace.
  clear() {
    this.#next = null;
    this.#list.replaceChildren();
    this.#usage.textContent = messages.loadingTickets;
    this.#more.hidden = true;
  }

  // Request the next page using the cursor returned by the previous response.
  loadMore() {
    return this.load(this.#next);
  }

  // Replace the history on refresh or append results for a supplied cursor. Ignore stale responses by
  // checking both the request number and the session revision.
  async load(cursor = null) {
    const request = ++this.#request;
    const revision = this.#client.sessionRevision;
    const isCurrent = () => request === this.#request && revision === this.#client.sessionRevision;
    this.#usage.textContent = messages.loadingTickets;
    this.#refresh.disabled = true;
    this.#more.disabled = true;
    try {
      const path = '/tickets' + (cursor ? '?after=' + encodeURIComponent(cursor) : '');
      const { tickets, submissions, next } = await this.#client.request(path);
      if (!isCurrent()) return;
      if (!cursor) this.#list.replaceChildren();
      this.#list.append(...tickets.map(this.#renderRow));
      this.#usage.textContent = this.#list.childElementCount || submissions
        ? messages.submissions(submissions)
        : messages.noTickets;
      this.#next = next;
      this.#more.hidden = !next;
    } catch (error) {
      if (isCurrent()) {
        this.#usage.textContent = messages.historyFailed;
        throw error;
      }
    } finally {
      if (request === this.#request) {
        this.#refresh.disabled = false;
        this.#more.disabled = false;
      }
    }
  }
}
