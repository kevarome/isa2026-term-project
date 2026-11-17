import { API_ORIGIN } from './config.js';
import { setupUsageReport } from './usage.js';

const $ = id => document.getElementById(id);
const accessForm = $('access-form');
const ticketForm = $('ticket-form');
const queueForm = $('queue-form');
const detailDialog = $('ticket-detail');
const editForm = $('edit-ticket');
const labels = {
  billing: 'Billing', technical: 'Technical', account: 'Account',
  general: 'General Support', low: 'Low', medium: 'Medium', high: 'High',
  manual_review: 'Awaiting manual review', open: 'Open', in_progress: 'In progress',
  resolved: 'Resolved', closed: 'Closed', unclassified: 'Unclassified',
  unassigned: 'Unassigned', unprioritized: 'Unprioritized'
};
const reviewReasons = {
  low_confidence: 'Confidence was below the routing threshold.',
  unavailable: 'AI classification was unavailable when this ticket was submitted.',
  invalid_output: 'The model returned an invalid classification.',
  provider_error: 'The model request failed.',
  timeout: 'The model request timed out.',
  seeded: 'Seeded demo ticket.'
};
const modelNames = {
  '@cf/cloudflare/clef-flash': 'Cloudflare Clef Flash',
  'typesafe/jev': 'TypeSafe Jev',
  'typesafe/jev-1.14.0': 'TypeSafe Jev 1.14'
};
const examples = {
  outage: 'My internet has been down since this morning, and I need the connection to work from home.',
  billing: 'My internet bill shows the same monthly plan charge twice. Could you check the second charge?',
  account: 'I forgot my password and the reset email never arrived. Can you help me regain access?',
  plan: 'Which residential plans are available for a household that streams video on two devices?'
};
const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
let token = sessionStorage.getItem('ticketmaestro-token');
let registering = false;
let nextUser = null;
let nextCustomerTicket = null;
let nextQueueTicket = null;
let customerRequest = 0;
let queueFilters = new URLSearchParams();
let queueRequest = 0;
let activeDetail = null;
let saving = false;
const usageReport = setupUsageReport(api);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function notify(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

function detailNotice(message = '', error = false) {
  $('detail-notice').textContent = message;
  $('detail-notice').classList.toggle('error', error);
}

function show(view, admin = false) {
  for (const id of ['access', 'customer', 'staff']) $(id).hidden = id !== view;
  document.body.classList.toggle('admin-mode', admin);
  $('admin-sidebar').hidden = !admin;
  if (!admin) {
    usageReport.clear();
    $('admin-email').textContent = '';
    $('users').replaceChildren();
    $('totals').textContent = '';
  }
  $('logout').hidden = view === 'access';
  if (view === 'access' && detailDialog.open) detailDialog.close();
}

function saveToken(value) {
  token = value;
  if (value) sessionStorage.setItem('ticketmaestro-token', value);
  else sessionStorage.removeItem('ticketmaestro-token');
}

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const headers = {};
  const requestToken = token;
  if (requestToken) headers.Authorization = 'Bearer ' + requestToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API_ORIGIN + '/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401 && requestToken && requestToken === token) {
    saveToken(null);
    show('access');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    throw Object.assign(new Error(result?.error || 'Request failed. Try again.'), { status: response.status });
  }
  return result;
}

function errorMessage(error) {
  return error instanceof TypeError ? 'Could not reach the API. Try again.' : error.message;
}

function updateAccessForm() {
  $('access-title').textContent = registering ? 'Create an account' : 'Sign in';
  $('access-submit').textContent = $('access-title').textContent;
  $('access-switch').textContent = registering ? 'Back to sign in' : 'Create an account';
  const password = accessForm.elements.password;
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.minLength = registering ? 12 : 1;
}

function ticketPriority(ticket) {
  return ticket.priority === undefined ? ticket.urgency : ticket.priority;
}

function ticketRow(ticket, staff) {
  const row = node('li', undefined, 'ticket-row');
  const button = node('button', undefined, 'ticket-link');
  button.type = 'button';
  const summary = node('span', undefined, 'ticket-line');
  const status = node('span', labels[ticket.status], 'ticket-status');
  status.dataset.status = ticket.status;
  const priority = ticketPriority(ticket);
  const priorityText = node('span', priority ? labels[priority] + ' priority' : labels.unprioritized, 'ticket-priority');
  priorityText.dataset.priority = priority ?? '';
  summary.append(status, node('strong', labels[ticket.department] ?? labels.unassigned), priorityText);
  const message = node('span', ticket.message, 'ticket-preview');
  const identity = ticket.email ? ticket.email + ' · ' : '';
  const meta = node('span', `${identity}${ticket.created_at} UTC`, 'muted ticket-meta');
  const id = node('span', ticket.id, 'ticket-meta ticket-id muted');
  button.append(summary, message);
  if (staff) button.append(node('span', 'AI classification · ' + classificationResult(ticket), 'ticket-classification'));
  button.append(meta, id);
  button.onclick = () => void openTicket(ticket.id, staff);
  row.append(button);
  return row;
}

async function loadCustomerTickets(cursor = null) {
  const request = ++customerRequest;
  const requestToken = token;
  const isCurrent = () => request === customerRequest && requestToken === token;
  $('usage').textContent = 'Loading tickets…';
  $('refresh-customer-tickets').disabled = true;
  $('more-customer-tickets').disabled = true;
  try {
    const { tickets, usage, next } = await api('/tickets' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
    if (!isCurrent()) return;
    const list = $('tickets');
    if (!cursor) list.replaceChildren();
    list.append(...tickets.map(ticket => ticketRow(ticket, false)));
    $('usage').textContent = list.childElementCount || usage
      ? `${usage} ticket submission${usage === 1 ? '' : 's'}`
      : 'No tickets yet.';
    nextCustomerTicket = next;
    $('more-customer-tickets').hidden = !next;
  } catch (error) {
    if (isCurrent()) {
      $('usage').textContent = 'Could not load your tickets.';
      throw error;
    }
  } finally {
    if (request === customerRequest) {
      $('refresh-customer-tickets').disabled = false;
      $('more-customer-tickets').disabled = false;
    }
  }
}

async function loadUsers(cursor = null) {
  const requestToken = token;
  const data = await api('/admin/users' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
  if (requestToken !== token) return;
  if (!cursor) $('users').replaceChildren();
  for (const user of data.users) {
    const row = $('users').insertRow();
    for (const value of [user.email, user.role, user.created_at]) row.insertCell().textContent = value;
  }
  $('totals').textContent = `${data.totals.users} registered`;
  nextUser = data.next;
  $('more-users').hidden = !nextUser;
}

function selectedQueueFilters() {
  const filters = new URLSearchParams(new FormData(queueForm));
  for (const key of ['q', 'department', 'status']) {
    const value = filters.get(key)?.trim();
    if (value) filters.set(key, value);
    else filters.delete(key);
  }
  return filters;
}

async function loadQueue(filters = queueFilters, cursor = null) {
  const query = new URLSearchParams(filters);
  if (cursor) query.set('after', cursor);
  const request = ++queueRequest;
  const requestToken = token;
  const isCurrent = () => request === queueRequest && requestToken === token;
  $('queue-state').textContent = 'Loading tickets…';
  $('apply-filters').disabled = true;
  $('more-tickets').disabled = true;
  try {
    const { tickets, next } = await api('/tickets?' + query);
    if (!isCurrent()) return;
    const list = $('queue-tickets');
    if (!cursor) list.replaceChildren();
    list.append(...tickets.map(ticket => ticketRow(ticket, true)));
    $('queue-state').textContent = list.childElementCount
      ? `${list.childElementCount} ticket${list.childElementCount === 1 ? '' : 's'} shown`
      : 'No tickets match these filters.';
    queueFilters = filters;
    nextQueueTicket = next;
    $('more-tickets').hidden = !next;
  } catch (error) {
    if (isCurrent()) {
      $('queue-state').textContent = 'Could not load tickets.';
      throw error;
    }
  } finally {
    if (request === queueRequest) {
      $('apply-filters').disabled = false;
      $('more-tickets').disabled = false;
    }
  }
}

function labeledValue(term, value) {
  const entry = node('div');
  entry.append(node('dt', term), node('dd', value));
  return entry;
}

async function loadStats() {
  const requestToken = token;
  try {
    const stats = await api('/stats');
    if (requestToken !== token) return;
    $('stats-total').textContent = `${stats.total} ticket${stats.total === 1 ? '' : 's'}`;
    const groups = [
      ['Assigned department', stats.byDepartment],
      ['AI category', stats.byCategory],
      ['Status', stats.byStatus],
      ['Priority', stats.byPriority]
    ];
    $('stats-breakdown').replaceChildren(...groups.map(([heading, counts]) => {
      const group = node('section');
      const list = node('dl');
      list.append(...Object.entries(counts).map(([key, value]) => labeledValue(labels[key] ?? key, value)));
      group.append(node('h3', heading), list);
      return group;
    }));
  } catch (error) {
    if (requestToken === token) $('stats-total').textContent = 'Statistics unavailable';
    throw error;
  }
}

function classificationResult(ticket) {
  const result = [];
  const model = ticket.classification_model;
  if (model) result.push(Object.hasOwn(modelNames, model) ? modelNames[model] : model);
  const department = ticket.classification_department ?? ticket.jev_department;
  const urgency = ticket.classification_urgency ?? ticket.jev_urgency;
  if (department && urgency) {
    result.push(`${labels[department]} · ${labels[urgency]} urgency`);
  }
  if (typeof ticket.confidence === 'number') result.push(percent.format(ticket.confidence) + ' confidence');
  const reason = reviewReasons[ticket.classification_outcome];
  if (reason) result.push(reason);
  return result.join(' · ') || 'This ticket has no saved AI classification.';
}

function renderDetail(detail, ticket) {
  detail.ticket = ticket;
  $('detail-id').textContent = ticket.id;
  const identity = ticket.email ? ticket.email + ' · ' : '';
  const updated = ticket.updated_at && ticket.updated_at !== ticket.created_at ? ` · Updated ${ticket.updated_at} UTC` : '';
  $('detail-submitted').textContent = `${identity}Submitted ${ticket.created_at} UTC${updated}`;
  $('detail-message').textContent = ticket.message;
  const priority = ticketPriority(ticket);
  $('detail-routing').replaceChildren(
    labeledValue('Status', labels[ticket.status]),
    labeledValue('Assigned department', labels[ticket.department] ?? labels.unassigned),
    labeledValue('Priority', labels[priority] ?? labels.unprioritized)
  );
  $('detail-ai').hidden = !detail.staff;
  editForm.hidden = !detail.staff;
  if (detail.staff) {
    $('detail-classification').textContent = classificationResult(ticket);
    editForm.elements.department.value = ticket.department ?? '';
    editForm.elements.priority.value = priority ?? '';
    editForm.elements.status.value = ticket.status;
  }
  $('detail-content').hidden = false;
}

async function openTicket(id, staff) {
  const detail = { id, staff, ticket: null };
  activeDetail = detail;
  $('detail-content').hidden = true;
  detailNotice('Loading ticket…');
  detailDialog.showModal();
  try {
    const { ticket } = await api('/tickets/' + encodeURIComponent(id));
    if (activeDetail !== detail || !detailDialog.open) return;
    renderDetail(detail, ticket);
    detailNotice();
  } catch (error) {
    if (activeDetail === detail && detailDialog.open) detailNotice(errorMessage(error), true);
  }
}

async function openAdminPage(focusHeading = false) {
  if (!document.body.classList.contains('admin-mode')) return;
  const pages = { 'api-usage': 'API usage', 'ticket-queue': 'Ticket queue', 'registered-users': 'Registered users' };
  const requested = location.hash.slice(1);
  const page = Object.hasOwn(pages, requested) ? requested : 'api-usage';
  $('staff-title').textContent = pages[page];
  $('usage-panel').hidden = page !== 'api-usage';
  $('staff-queue').hidden = page !== 'ticket-queue';
  $('admin-users').hidden = page !== 'registered-users';
  for (const link of $('admin-sidebar').querySelectorAll('a')) {
    if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (focusHeading) $('staff-title').focus();
  if (page === 'api-usage') return usageReport.load();
  usageReport.clear();
  if (page === 'registered-users') return loadUsers();
  await Promise.all([loadQueue(selectedQueueFilters()), loadStats()]);
}

async function openWorkspace(user) {
  if (user.role === 'admin' || user.role === 'staff') {
    const admin = user.role === 'admin';
    $('staff-title').textContent = 'Support dashboard';
    $('staff-email').textContent = [user.email, labels[user.department]].filter(Boolean).join(' · ');
    $('staff-email').hidden = admin;
    $('admin-email').textContent = admin ? user.email : '';
    $('admin-users').hidden = true;
    $('usage-panel').hidden = true;
    $('staff-queue').hidden = false;
    $('queue-title').textContent = admin ? 'Tickets' : 'Ticket queue';
    $('usage-period').value = '7';
    $('users').replaceChildren();
    $('totals').textContent = 'Loading users…';
    $('more-users').hidden = true;
    $('queue-tickets').replaceChildren();
    $('more-tickets').hidden = true;
    $('stats-total').textContent = 'Loading…';
    $('stats-breakdown').replaceChildren();
    queueForm.reset();
    queueForm.elements.department.value = user.department ?? '';
    show('staff', admin);
    if (admin) await openAdminPage();
    else await Promise.all([loadQueue(selectedQueueFilters()), loadStats()]);
  } else {
    $('customer-email').textContent = user.email;
    $('tickets').replaceChildren();
    $('usage').textContent = 'Loading tickets…';
    $('more-customer-tickets').hidden = true;
    show('customer');
    await loadCustomerTickets();
  }
}

async function run(task, button) {
  if (button) button.disabled = true;
  notify();
  try {
    await task();
  } catch (error) {
    notify(errorMessage(error), true);
  } finally {
    if (button) button.disabled = false;
  }
}

$('access-switch').onclick = () => {
  registering = !registering;
  updateAccessForm();
  notify();
};

accessForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const credentials = Object.fromEntries(new FormData(accessForm));
    $('access-switch').disabled = true;
    try {
      if (registering) {
        await api('/auth/register', credentials);
        registering = false;
        updateAccessForm();
        notify('Account created. Sign in to continue.');
        return;
      }
      const result = await api('/auth/login', credentials);
      saveToken(result.token);
      await openWorkspace(result.user);
    } finally {
      accessForm.elements.password.value = '';
      $('access-switch').disabled = false;
    }
  }, $('access-submit'));
};

for (const button of $('ticket-examples').querySelectorAll('button')) {
  button.onclick = () => {
    ticketForm.elements.message.value = examples[button.dataset.sample];
    ticketForm.elements.message.focus();
  };
}

ticketForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const message = ticketForm.elements.message;
    const requestToken = token;
    message.readOnly = true;
    $('ticket-examples').disabled = true;
    notify('Submitting ticket…');
    try {
      const { ticket } = await api('/tickets', { message: message.value });
      if (requestToken !== token) return;
      ticketForm.reset();
      const confirmation = ticket.status === 'manual_review'
        ? 'Your ticket was saved for manual review.'
        : `Your ticket was routed to ${labels[ticket.department]}.`;
      const saved = `${confirmation} Ticket ID ${ticket.id}.`;
      notify(saved);
      try {
        await loadCustomerTickets();
      } catch {
        notify(saved + ' Refresh your tickets to see the latest history.', true);
      }
    } finally {
      message.readOnly = false;
      $('ticket-examples').disabled = false;
    }
  }, $('ticket-submit'));
};

queueForm.onsubmit = event => {
  event.preventDefault();
  void run(() => loadQueue(selectedQueueFilters()));
};

editForm.onsubmit = async event => {
  event.preventDefault();
  const detail = activeDetail;
  if (saving || !detail?.staff || !detail.ticket) return;
  const current = detail.ticket;
  const values = new FormData(editForm);
  const patch = {};
  const department = values.get('department') || null;
  const priority = values.get('priority') || null;
  const status = values.get('status');
  if (department !== (current.department ?? null)) patch.department = department;
  if (priority !== (ticketPriority(current) ?? null)) patch.priority = priority;
  if (status !== current.status) patch.status = status;
  if (Object.keys(patch).length === 0) {
    detailNotice('There are no changes to save.');
    return;
  }
  const path = '/tickets/' + encodeURIComponent(detail.id);
  const isCurrent = () => activeDetail === detail && detailDialog.open;
  const requestToken = token;
  saving = true;
  $('edit-save').disabled = true;
  $('edit-fields').disabled = true;
  detailNotice('Saving changes…');
  try {
    const { ticket } = await api(path, { ...patch, version: current.version }, 'PATCH');
    if (isCurrent()) {
      renderDetail(detail, ticket);
      detailNotice('Ticket updated.');
    }
    if (requestToken === token) {
      try {
        await Promise.all([loadQueue(), loadStats()]);
      } catch {
        if (isCurrent()) detailNotice('Ticket updated. Reload the page to refresh the dashboard.', true);
      }
    }
  } catch (error) {
    if (error.status === 409 && isCurrent()) {
      try {
        const { ticket } = await api(path);
        if (isCurrent()) {
          renderDetail(detail, ticket);
          detailNotice('This ticket changed while you were editing. Review its current values and apply your changes again.', true);
        }
      } catch (reloadError) {
        if (isCurrent()) detailNotice(errorMessage(reloadError), true);
      }
    } else if (isCurrent()) {
      detailNotice(errorMessage(error), true);
    }
  } finally {
    saving = false;
    $('edit-save').disabled = false;
    $('edit-fields').disabled = false;
  }
};

detailDialog.onclose = () => {
  activeDetail = null;
  if (document.activeElement === document.body && !$('staff').hidden) $('queue-title').focus();
};

$('refresh-customer-tickets').onclick = () => void run(() => loadCustomerTickets());
$('more-customer-tickets').onclick = () => void run(() => loadCustomerTickets(nextCustomerTicket));
$('more-users').onclick = () => void run(() => loadUsers(nextUser), $('more-users'));
$('more-tickets').onclick = () => void run(() => loadQueue(queueFilters, nextQueueTicket));
window.addEventListener('hashchange', () => {
  if (document.body.classList.contains('admin-mode')) void run(() => openAdminPage(true));
});
$('logout').onclick = () => void run(async () => {
  await api('/auth/logout', {});
  saveToken(null);
  ticketForm.reset();
  show('access');
}, $('logout'));

if (token) {
  try {
    await openWorkspace((await api('/auth/me')).user);
  } catch (error) {
    if ($('staff').hidden && $('customer').hidden) show('access');
    notify(errorMessage(error), true);
  }
} else {
  show('access');
}
