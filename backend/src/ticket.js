const priorityRank = { low: 1, medium: 2, high: 3 };

// A persisted ticket knows how to present its data to each role and apply staff routing decisions.
export class Ticket {
  #record;

  // Keep the D1 row, including staff-only metadata, until the caller requests a response.
  constructor(record) {
    this.#record = record;
  }

  // Convert a database row to the ticket response shape and expose urgency as priority.
  // Include the submitter's email, edit version, and original AI details for staff views.
  toResponse(staff = false) {
    const record = this.#record;
    const { id, message, department, urgency, confidence, status, created_at, updated_at } = record;
    const ticket = { id, message, department, urgency, priority: urgency, confidence, status, created_at, updated_at };
    if (staff) {
      Object.assign(ticket, {
        email: record.email,
        version: record.version,
        classification_outcome: record.classification_outcome,
        classification_model: record.classification_model,
        classification_department: record.suggested_department,
        classification_urgency: record.suggested_urgency,
        jev_department: record.suggested_department,
        jev_urgency: record.suggested_urgency
      });
    }
    return ticket;
  }

  // Return the fields that identify a ticket's position in the requested sort order.
  // Priority sorting includes the numeric urgency rank. Creation time and ID break ties.
  pageKey(sort) {
    const ticket = this.#record;
    return sort === 'priority'
      ? [priorityRank[ticket.urgency] ?? 0, ticket.created_at, ticket.id]
      : [ticket.created_at, ticket.id];
  }

  // Encode the last visible ticket's sort values for the next page.
  // Legacy administrator clients pass the ticket ID directly.
  nextCursor(sort, legacy) {
    if (legacy) return this.#record.id;
    const cursor = [sort, ...this.pageKey(sort)];
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
  }

  // Retain omitted fields and open a ticket leaving manual review when staff assign a department.
  // An explicit status always takes precedence over the automatic transition.
  routingAfter({ department, priority, status }) {
    return {
      department: department === undefined ? this.#record.department : department,
      priority: priority === undefined ? this.#record.urgency : priority,
      status: status ?? (this.#record.status === 'manual_review' && department ? 'open' : this.#record.status)
    };
  }
}
