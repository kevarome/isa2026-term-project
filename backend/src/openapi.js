const ref = name => ({ $ref: '#/components/schemas/' + name });
const string = { type: 'string' };
const integer = { type: 'integer' };
const nullableText = { type: 'string', nullable: true };
const count = { type: 'integer', minimum: 0 };
const array = items => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const enumeration = values => ({ type: 'string', enum: values });
const departments = ['billing', 'technical', 'account', 'general'];
const department = enumeration(departments);
const priority = enumeration(['low', 'medium', 'high']);
const nullableChoice = choice => ({ ...choice, nullable: true, enum: [...choice.enum, null] });
const status = enumeration(['manual_review', 'open', 'in_progress', 'resolved', 'closed']);
const email = { type: 'string', format: 'email', maxLength: 254 };
const registrationPassword = { type: 'string', format: 'password', minLength: 12, maxLength: 128 };
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, description });
const id = { name: 'id', in: 'path', required: true, schema: string, description: 'Resource ID returned by the API.' };
const pageParameters = [
  query('after', string, 'Use the previous page’s next value with the same search, filters and order.'),
  query('q', { ...string, maxLength: 200 }, 'Search message or ticket ID. Staff and administrators can also search email.'),
  query('department', enumeration([...departments, 'unassigned']), 'Current assignment.'),
  query('status', status, 'Current ticket status.'),
  query('sort', enumeration(['newest', 'priority']), 'Customers default to newest. Staff queues default to priority.')
];
const user = { id: '73ee9e62-17e9-4161-8e27-11bf4961046e', email: 'casey@example.test', role: 'user' };
const ticket = {
  id: '81ec00d2-4aeb-4c6c-82b7-ea5636d13bd8', message: 'My internet connection is down.',
  department: 'technical', priority: 'high', urgency: 'high', confidence: 0.93, status: 'open',
  created_at: '2026-03-01 12:00:00', updated_at: '2026-03-01 12:00:00'
};
const staffTicket = {
  ...ticket, email: user.email, version: 1, classification_model: '@cf/cloudflare/clef-flash',
  classification_outcome: 'classified', classification_department: 'technical', classification_urgency: 'high',
  jev_department: 'technical', jev_urgency: 'high'
};
const byValue = { type: 'object', additionalProperties: count };
const traffic = { requests: count, errors: count };
const route = { method: string, route: string };
const latency = { type: 'integer', nullable: true };
const schemas = {
  User: object({ id: string, email, role: enumeration(['user', 'staff', 'admin']), department }, ['id', 'email', 'role']),
  Ticket: object({
    id: string, message: string, department: nullableChoice(department), priority: nullableChoice(priority),
    urgency: nullableChoice(priority), confidence: { type: 'number', minimum: 0, maximum: 1, nullable: true },
    status, created_at: string, updated_at: nullableText
  }),
  StaffTicket: { allOf: [ref('Ticket'), object({
    email, version: integer, classification_outcome: string, classification_model: nullableText,
    classification_department: nullableChoice(department), classification_urgency: nullableChoice(priority),
    jev_department: nullableChoice(department), jev_urgency: nullableChoice(priority)
  })] },
  Stats: object({ total: count, byCategory: byValue, byDepartment: byValue, byStatus: byValue, byPriority: byValue }),
  UsageReport: object({
    days: integer, from: string, to: string, summary: object({ ...traffic, avgDurationMs: latency, activeUsers: count }),
    daily: array(object({ date: string, ...traffic })),
    endpoints: array(object({ ...route, ...traffic, avgDurationMs: latency })),
    users: array(object({ email, ...traffic })),
    endpointTotals: array(object({ ...route, ...traffic })), userTotals: array(object({ id: string, email, requests: count }))
  }),
  Error: object({ error: string })
};
const apiHeaders = {
  'X-API-Calls-Used': { description: 'Lifetime counted requests for the current account.', schema: count },
  'X-API-Free-Limit': { description: 'The free allowance for this account.', schema: { ...integer, example: 20 } },
  'X-API-Free-Exceeded': { description: 'True after the account exceeds the free allowance.', schema: { type: 'boolean' } }
};
const cookieHeader = { 'Set-Cookie': { description: 'Sets or clears the HttpOnly session cookie.', schema: string } };
const errorDescriptions = {
  400: 'Invalid input or malformed JSON.', 401: 'Invalid credentials or missing, expired or revoked session.',
  403: 'Origin or role is not authorized.', 404: 'Resource not found or outside the account’s access.',
  409: 'The operation conflicts with the current account or resource state.', 413: 'The JSON body exceeds 16 KiB.',
  429: 'Too many requests in a short interval.', 500: 'Internal server error.', 503: 'The service is unavailable.'
};
const json = (schema, example) => ({ 'application/json': { schema, example } });
const request = (schema, example) => ({ required: true, content: json(schema, example) });
const response = (schema, example) => ({ description: 'Successful response.', content: json(schema, example) });
const userResponse = response(object({ user: ref('User') }), { user });
const ticketResponse = response(object({ ticket: ref('Ticket') }), { ticket });
const staffTicketResponse = response(object({ ticket: ref('StaffTicket') }), { ticket: staffTicket });
const ticketPage = (itemSchema, item) => response(
  object({ tickets: array(itemSchema), next: nullableText }, ['tickets', 'next']),
  { tickets: [item], next: null }
);
const deleted = response(object({ deleted: { type: 'boolean' } }), { deleted: true });

function operation(tag, summary, success, options = {}) {
  const { statusCode = 200, description, publicRoute = false, counted = !publicRoute,
    headers = {}, parameters, body, errors = [] } = options;
  const responses = { [statusCode]: { ...success, headers: { ...(counted ? apiHeaders : {}), ...headers } } };
  for (const code of new Set([403, 500, ...(!publicRoute ? [401] : []), ...(body ? [400, 413] : []), ...errors])) {
    responses[code] = { $ref: '#/components/responses/Error' + code };
  }
  return {
    tags: [tag], summary, ...(description && { description }), ...(publicRoute && { security: [] }),
    ...(parameters && { parameters }), ...(body && { requestBody: body }), responses
  };
}

const customerOrStaff = { anyOf: [ref('Ticket'), ref('StaffTicket')] };
const ticketList = response(object({
  tickets: array(customerOrStaff), next: nullableText,
  usage: { ...count, description: 'Customer’s lifetime counted calls, including this read.' },
  submissions: { ...count, description: 'Customer’s number of ticket submissions.' }
}, ['tickets', 'next']), { tickets: [ticket], next: null, usage: 2, submissions: 1 });
const adminUser = object({ id: string, email, role: enumeration(['user', 'staff', 'admin']), department: nullableText, created_at: string });
const periodRow = { method: 'GET', route: '/api/v1/tickets', requests: 1, errors: 0, avgDurationMs: 4 };
const exampleReport = {
  days: 7, from: '2026-03-01', to: '2026-03-07', summary: { requests: 1, errors: 0, avgDurationMs: 4, activeUsers: 1 },
  daily: Array.from({ length: 7 }, (_, day) => ({ date: '2026-03-0' + (day + 1), requests: day === 0 ? 1 : 0, errors: 0 })),
  endpoints: [periodRow], users: [{ email: user.email, requests: 1, errors: 0 }],
  endpointTotals: [{ method: 'GET', route: '/api/v1/tickets', requests: 1, errors: 0 }],
  userTotals: [{ id: user.id, email: user.email, requests: 1 }]
};

export const openApi = {
  openapi: '3.0.3',
  info: {
    title: 'TicketMaestro API', version: '1.0.0',
    description: 'Sign in with POST /auth/login to use protected operations from this page. The browser sends the session cookie automatically. Each authenticated functional request counts toward the account’s 20 free calls. Requests continue after the allowance runs out. Health, authentication lifecycle, documentation and preflight requests are excluded.'
  },
  servers: [{ url: '/api/v1' }],
  security: [{ sessionCookie: [] }],
  components: {
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ticketmaestro_session', description: 'HttpOnly signed JWT issued by the login endpoint.' } },
    schemas,
    responses: Object.fromEntries(Object.entries(errorDescriptions).map(([code, description]) =>
      ['Error' + code, { description, content: json(ref('Error'), { error: description }) }]))
  },
  paths: {
    '/health': {
      get: operation('Health', 'Check the API and D1 connection', response(object({ status: string, database: string }), { status: 'ok', database: 'connected' }), { publicRoute: true })
    },
    '/auth/register': {
      post: operation('Accounts', 'Register a customer', userResponse, { publicRoute: true, statusCode: 201,
        body: request(object({ email, password: registrationPassword }), { email: user.email, password: 'Example-password-42' }), errors: [409, 429] })
    },
    '/auth/login': {
      post: operation('Accounts', 'Sign in and receive a session cookie', userResponse, {
        publicRoute: true, counted: false, headers: { ...apiHeaders, ...cookieHeader }, errors: [401, 429],
        description: 'The session expires after eight hours. Use credentials: include for a cross-origin browser request.',
        body: request(object({ email, password: { ...string, format: 'password', minLength: 1, maxLength: 128 } }), { email: user.email, password: 'Example-password-42' })
      })
    },
    '/auth/me': { get: operation('Accounts', 'Read the signed-in user and current usage headers', userResponse) },
    '/auth/logout': {
      post: operation('Accounts', 'Revoke the session and clear the cookie', response(object({ signedOut: { type: 'boolean' } }), { signedOut: true }), { counted: false, headers: cookieHeader })
    },
    '/auth/password-reset/request': {
      post: operation('Accounts', 'Request a password reset', response(object({ accepted: { type: 'boolean' }, delivery: enumeration(['local', 'email']) }), { accepted: true, delivery: 'email' }), {
        statusCode: 202, publicRoute: true, body: request(object({ email }), { email: user.email }), errors: [429, 503],
        description: 'A valid address receives the same response whether or not it belongs to an account.'
      })
    },
    '/auth/password-reset/confirm': {
      post: operation('Accounts', 'Redeem a reset link and revoke active sessions', response(object({ reset: { type: 'boolean' } }), { reset: true }), {
        publicRoute: true, errors: [429], body: request(object({ token: { ...string, pattern: '^[a-fA-F0-9]{64}$' }, password: registrationPassword }),
          { token: '0123456789abcdef'.repeat(4), password: 'Another-example-42' })
      })
    },
    '/tickets': {
      get: operation('Tickets', 'List and search tickets visible to the caller', ticketList, {
        parameters: pageParameters, errors: [400], description: 'Up to 30 tickets per page. Customers see their own records. Staff and administrators see queues across accounts and receive original AI classifications and edit versions.'
      }),
      post: operation('Tickets', 'Submit a ticket for AI classification', ticketResponse, {
        statusCode: 201, errors: [429], body: request(object({ message: { ...string, minLength: 10, maxLength: 2000 } }), { message: ticket.message }),
        description: 'A validated model suggestion sets the department and urgency. Low confidence, an invalid response or an unavailable model sends the ticket to manual review.'
      })
    },
    '/tickets/{id}': {
      get: operation('Tickets', 'Read an owned ticket or inspect it as staff', response(object({ ticket: customerOrStaff }), { ticket }), { parameters: [id], errors: [404] }),
      patch: operation('Tickets', 'Edit a ticket as staff or administrator', staffTicketResponse, {
        parameters: [id], errors: [404, 409], description: 'Send at least one of department, priority and status. Supply the latest version to reject a stale edit. A null department or priority clears the field.',
        body: request({ type: 'object', additionalProperties: false, properties: { department: nullableChoice(department), priority: nullableChoice(priority), status, version: { ...integer, minimum: 1 } },
          anyOf: ['department', 'priority', 'status'].map(field => ({ required: [field] })) }, { department: 'technical', status: 'in_progress', version: 1 })
      })
    },
    '/stats': {
      get: operation('Tickets', 'Read ticket counts as staff or administrator', response(ref('Stats'), {
        total: 1, byCategory: { billing: 0, technical: 1, account: 0, general: 0, unclassified: 0 },
        byDepartment: { billing: 0, technical: 1, account: 0, general: 0, unassigned: 0 },
        byStatus: { manual_review: 0, open: 1, in_progress: 0, resolved: 0, closed: 0 },
        byPriority: { low: 0, medium: 0, high: 1, unprioritized: 0 }
      }))
    },
    '/admin/tickets': {
      get: operation('Administration', 'List all tickets as administrator', ticketPage(ref('StaffTicket'), staffTicket), {
        parameters: pageParameters.map(param => param.name === 'sort' ? { ...param, description: 'Defaults to newest.' } : param),
        errors: [400], description: 'Up to 30 tickets per page. The next cursor on this route is a ticket ID.'
      })
    },
    '/admin/tickets/{id}': { delete: operation('Administration', 'Delete a ticket as administrator', deleted, { parameters: [id], errors: [404] }) },
    '/admin/users': {
      get: operation('Administration', 'List registered accounts as administrator', response(
        object({ users: array(adminUser), next: nullableText, totals: object({ users: count, submissions: count }) }),
        { users: [{ ...user, department: null, created_at: ticket.created_at }], next: null, totals: { users: 1, submissions: 1 } }
      ), { parameters: [query('after', string, 'Previous page’s next email cursor. Pages contain up to 50 accounts.')] })
    },
    '/admin/users/{id}': { delete: operation('Administration', 'Remove an account and its tickets as administrator', deleted, {
      parameters: [id], errors: [404, 409], description: 'Administrators cannot delete their own account.'
    }) },
    '/admin/usage': {
      get: operation('Administration', 'Read endpoint and account consumption as administrator', response(ref('UsageReport'), exampleReport), {
        errors: [400], parameters: [query('days', { ...integer, enum: [7, 30, 90], default: 7 }, 'UTC reporting window, including today.')],
        description: 'The summary, daily, endpoints and users cover the selected window. endpointTotals includes every API endpoint and userTotals includes every registered account, each with a lifetime total. The report example shows one endpoint row.'
      })
    }
  }
};
