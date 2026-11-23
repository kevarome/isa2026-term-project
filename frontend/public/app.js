// The browser entry point connects the HTML controls to the API and opens the workspace for the
// signed-in role.
import { API_ORIGIN } from './config.js';
import { ApiClient } from './api-client.js';
import { CustomerTicketList } from './customer-ticket-list.js';
import { UsageReport } from './usage.js';

const $ = id => document.getElementById(id);
const accessForm = $('access-form');
const resetRequestForm = $('reset-request-form');
const resetPasswordForm = $('reset-password-form');
const ticketForm = $('ticket-form');
const queueForm = $('queue-form');
const detailDialog = $('ticket-detail');
const deleteDialog = $('confirm-delete');
const editForm = $('edit-ticket');
// Translate API identifiers into the names displayed in the forms, queues, and statistics.
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
// Keep the current form, page cursors, and pending dialog actions in memory for this tab.
let accessMode = 'login';
let resetToken = null;
let nextUser = null;
let nextQueueTicket = null;
let queueFilters = new URLSearchParams();
let queueRequest = 0;
let activeDetail = null;
let saving = false;
let adminId = null;
let userRequest = 0;
let deleteTarget = null;
const client = new ApiClient(API_ORIGIN, () => show('access'));
const usageReport = new UsageReport(client);
const customerTickets = new CustomerTicketList(client, ticket => ticketRow(ticket, false));

// Build an element and insert supplied text with textContent, which treats messages and names as plain
// text.
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

// Set or clear the page-wide status banner and apply its error styling when needed.
function notify(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

// Show feedback inside the ticket dialog so someone editing a ticket can see the result without closing
// it.
function detailNotice(message = '', error = false) {
  $('detail-notice').textContent = message;
  $('detail-notice').classList.toggle('error', error);
}

// Switch between the access, customer, and support views. Clear administrator data and close its delete
// dialog when leaving admin mode.
function show(view, admin = false) {
  for (const id of ['access', 'customer', 'staff']) $(id).hidden = id !== view;
  document.body.classList.toggle('admin-mode', admin);
  $('admin-sidebar').hidden = !admin;
  if (!admin) {
    adminId = null;
    if (deleteDialog.open) deleteDialog.close();
    usageReport.clear();
    $('admin-email').textContent = '';
    $('users').replaceChildren();
    $('totals').textContent = '';
  }
  $('logout').hidden = view === 'access';
  if (view === 'access' && detailDialog.open) detailDialog.close();
}

// Give network failures a friendly message and display the API error message for other failures.
function errorMessage(error) {
  return error instanceof TypeError ? 'Could not reach the API. Try again.' : error.message;
}

// Use aria-controls to find the input and keep the button text and accessible label in sync with
// visibility.
function setPasswordVisible(button, visible) {
  $(button.getAttribute('aria-controls')).type = visible ? 'text' : 'password';
  button.textContent = visible ? 'Hide' : 'Show';
  button.setAttribute('aria-label', `${button.textContent} ${button.dataset.passwordToggle}`);
}

// Show the form for the selected authentication step. Reset password fields and visibility, and set the
// password requirement and autocomplete hint for sign-in or registration.
function setAccessMode(mode) {
  accessMode = mode;
  const registering = mode === 'register';
  const authenticating = mode === 'login' || registering;
  const title = { login: 'Sign in', register: 'Create an account', request: 'Forgot password?', reset: 'Reset password' };
  $('access-title').textContent = title[mode];
  accessForm.hidden = !authenticating;
  resetRequestForm.hidden = mode !== 'request';
  resetPasswordForm.hidden = mode !== 'reset';
  $('access-submit').textContent = title[mode];
  $('access-switch').hidden = !authenticating;
  $('access-switch').textContent = registering ? 'Back to sign in' : 'Create an account';
  $('forgot-password').hidden = mode !== 'login';
  $('reset-back').hidden = authenticating;
  const password = accessForm.elements.password;
  password.value = '';
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.minLength = registering ? 12 : 1;
  resetPasswordForm.reset();
  for (const button of $('access').querySelectorAll('[data-password-toggle]')) setPasswordVisible(button, false);
  if (mode !== 'reset') resetToken = null;
}

// Consume the reset token from the fragment and immediately remove it from the address bar. Return true
// when the fragment was handled, including when its format was invalid.
function openResetLink() {
  const prefix = '#reset-password=';
  if (!location.hash.startsWith(prefix)) return false;
  const value = location.hash.slice(prefix.length);
  history.replaceState(history.state, '', location.pathname + location.search);
  show('access');
  if (!/^[a-f0-9]{64}$/.test(value)) {
    setAccessMode('request');
    notify('This reset link is invalid. Request a new one.', true);
    resetRequestForm.elements.email.focus();
    return true;
  }
  resetToken = value;
  setAccessMode('reset');
  notify();
  resetPasswordForm.elements.password.focus();
  return true;
}

// Read the current priority field, falling back to urgency for older responses. An explicit null still
// means unprioritized.
function ticketPriority(ticket) {
  return ticket.priority === undefined ? ticket.urgency : ticket.priority;
}

// Render one clickable ticket with its assignment, status, preview, and ID. The support queue also
// shows original AI information.
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

// Fetch one page of registered accounts. Ignore responses from replaced sessions or newer requests, and
// keep the signed-in admin out of the removal controls.
async function loadUsers(cursor = null) {
  const requestToken = client.token;
  const request = ++userRequest;
  const data = await client.request('/admin/users' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
  if (requestToken !== client.token || request !== userRequest || !adminId) return;
  if (!cursor) $('users').replaceChildren();
  for (const user of data.users) {
    const row = $('users').insertRow();
    for (const value of [user.email, user.role, user.created_at]) row.insertCell().textContent = value;
    const actions = row.insertCell();
    if (user.id !== adminId) {
      const remove = node('button', 'Remove', 'danger-action');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${user.email}`);
      remove.onclick = () => confirmDeletion('users', user);
      actions.append(remove);
    }
  }
  $('totals').textContent = `${data.totals.users} registered`;
  nextUser = data.next;
  $('more-users').hidden = !nextUser;
}

// Build a query string from the filter form. Trim text and omit blank filters while keeping the
// selected sort.
function selectedQueueFilters() {
  const filters = new URLSearchParams(new FormData(queueForm));
  for (const key of ['q', 'department', 'status']) {
    const value = filters.get(key)?.trim();
    if (value) filters.set(key, value);
    else filters.delete(key);
  }
  return filters;
}

// Fetch tickets using the selected filters and append a page when a cursor is supplied. Only the latest
// request for the current session can replace the list.
async function loadQueue(filters = queueFilters, cursor = null) {
  const query = new URLSearchParams(filters);
  if (cursor) query.set('after', cursor);
  const request = ++queueRequest;
  const requestToken = client.token;
  const isCurrent = () => request === queueRequest && requestToken === client.token;
  $('queue-state').textContent = 'Loading tickets…';
  $('apply-filters').disabled = true;
  $('more-tickets').disabled = true;
  try {
    const { tickets, next } = await client.request('/tickets?' + query);
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

// Build a term and description pair for the ticket summary or dashboard statistics.
function labeledValue(term, value) {
  const entry = node('div');
  entry.append(node('dt', term), node('dd', value));
  return entry;
}

// Fetch the counts for the support dashboard and render each grouping. Only update the dashboard for
// the session that started the request.
async function loadStats() {
  const requestToken = client.token;
  try {
    const stats = await client.request('/stats');
    if (requestToken !== client.token) return;
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
    if (requestToken === client.token) $('stats-total').textContent = 'Statistics unavailable';
    throw error;
  }
}

// Format the original AI suggestion, confidence, and review reason for staff. Support older field names
// for the suggested department and urgency.
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

// Render the current ticket and keep its latest version for editing. Fill in the routing form and
// original AI result for support users.
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
  $('delete-ticket').hidden = !adminId;
  if (detail.staff) {
    $('detail-classification').textContent = classificationResult(ticket);
    editForm.elements.department.value = ticket.department ?? '';
    editForm.elements.priority.value = priority ?? '';
    editForm.elements.status.value = ticket.status;
  }
  $('detail-content').hidden = false;
}

// Open the dialog before fetching the ticket. Only render a result if the same dialog request is still
// active.
async function openTicket(id, staff) {
  const detail = { id, staff, ticket: null };
  activeDetail = detail;
  $('detail-content').hidden = true;
  detailNotice('Loading ticket…');
  detailDialog.showModal();
  try {
    const { ticket } = await client.request('/tickets/' + encodeURIComponent(id));
    if (activeDetail !== detail || !detailDialog.open) return;
    renderDetail(detail, ticket);
    detailNotice();
  } catch (error) {
    if (activeDetail === detail && detailDialog.open) detailNotice(errorMessage(error), true);
  }
}

// Select the admin section from the URL fragment, highlight its navigation link, and load the
// corresponding data. Move focus to the heading after navigation when requested.
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

// Initialize the signed-in view from the returned user role. Staff start with their department
// selected, admins open their selected page, and customers load their history.
async function openWorkspace(user) {
  adminId = user.role === 'admin' ? user.id : null;
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
    customerTickets.clear();
    show('customer');
    await customerTickets.load();
  }
}

// Run a UI action with shared error feedback. If a button is supplied, disable it until the action
// finishes.
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

// Wire each show/hide control to the password input it names.
for (const button of $('access').querySelectorAll('[data-password-toggle]')) {
  button.onclick = () => setPasswordVisible(button, $(button.getAttribute('aria-controls')).type === 'password');
}

// Switch between sign-in and registration while clearing old feedback.
$('access-switch').onclick = () => {
  setAccessMode(accessMode === 'register' ? 'login' : 'register');
  notify();
};

// Carry the typed email from sign-in into the reset request form and focus it.
$('forgot-password').onclick = () => {
  resetRequestForm.elements.email.value = accessForm.elements.email.value;
  setAccessMode('request');
  resetRequestForm.elements.email.focus();
  notify();
};

// Return to sign-in after recovery and preserve the email from the reset request form.
$('reset-back').onclick = () => {
  if (accessMode === 'request') accessForm.elements.email.value = resetRequestForm.elements.email.value;
  setAccessMode('login');
  accessForm.elements.email.focus();
  notify();
};

// Register or sign in through the API. Store the token after a successful login and clear the password
// after every attempt.
accessForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const credentials = Object.fromEntries(new FormData(accessForm));
    $('access-switch').disabled = true;
    $('forgot-password').disabled = true;
    try {
      if (accessMode === 'register') {
        await client.request('/auth/register', credentials);
        setAccessMode('login');
        notify('Account created. Sign in to continue.');
        return;
      }
      const result = await client.request('/auth/login', credentials);
      client.token = result.token;
      await openWorkspace(result.user);
    } finally {
      accessForm.elements.password.value = '';
      setPasswordVisible(accessForm.querySelector('[data-password-toggle]'), false);
      $('access-switch').disabled = false;
      $('forgot-password').disabled = false;
    }
  }, $('access-submit'));
};

// Request a recovery link and show the generic confirmation for the configured delivery mode.
resetRequestForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    $('reset-back').disabled = true;
    try {
      const { delivery } = await client.request('/auth/password-reset/request', { email: resetRequestForm.elements.email.value });
      if (delivery === 'local') notify('If an account matches that email, a reset link will appear in the local API log.');
      else notify('If an account matches that email, you’ll receive a password reset link.');
    } finally {
      $('reset-back').disabled = false;
    }
  }, $('reset-request-submit'));
};

// Check that both password fields match, then exchange the reset token for a new password and return to
// sign-in.
resetPasswordForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const { password, confirmation } = resetPasswordForm.elements;
    if (password.value !== confirmation.value) {
      confirmation.focus();
      throw new Error('The passwords do not match.');
    }
    $('reset-back').disabled = true;
    try {
      await client.request('/auth/password-reset/confirm', { token: resetToken, password: password.value });
      client.token = null;
      setAccessMode('login');
      accessForm.elements.email.focus();
      notify('Password updated. Sign in with your new password.');
    } finally {
      $('reset-back').disabled = false;
    }
  }, $('reset-password-submit'));
};

// Fill the ticket form with an editable sample message and focus the input.
for (const button of $('ticket-examples').querySelectorAll('button')) {
  button.onclick = () => {
    ticketForm.elements.message.value = examples[button.dataset.sample];
    ticketForm.elements.message.focus();
  };
}

// Submit the ticket and display its ID and routing outcome. Treat a failure to refresh the history
// separately from a failure to save the ticket.
ticketForm.onsubmit = event => {
  event.preventDefault();
  void run(async () => {
    const message = ticketForm.elements.message;
    const requestToken = client.token;
    message.readOnly = true;
    $('ticket-examples').disabled = true;
    notify('Submitting ticket…');
    try {
      const { ticket } = await client.request('/tickets', { message: message.value });
      if (requestToken !== client.token) return;
      ticketForm.reset();
      const confirmation = ticket.status === 'manual_review'
        ? 'Your ticket was saved for manual review.'
        : `Your ticket was routed to ${labels[ticket.department]}.`;
      const saved = `${confirmation} Ticket ID ${ticket.id}.`;
      notify(saved);
      try {
        await customerTickets.load();
      } catch {
        notify(saved + ' Refresh your tickets to see the latest history.', true);
      }
    } finally {
      message.readOnly = false;
      $('ticket-examples').disabled = false;
    }
  }, $('ticket-submit'));
};

// Apply the current search and filters by loading a fresh first page.
queueForm.onsubmit = event => {
  event.preventDefault();
  void run(() => loadQueue(selectedQueueFilters()));
};

// Prepare the shared confirmation dialog for a ticket or account. Save the current session with the
// target to prevent reuse after an account switch.
function confirmDeletion(collection, record) {
  if (!adminId || deleteDialog.open) return;
  const user = collection === 'users';
  const action = user ? 'Remove user' : 'Delete ticket';
  deleteTarget = { collection, id: record.id, session: client.token };
  $('delete-title').textContent = action + '?';
  $('delete-confirm').textContent = action;
  $('delete-message').textContent = user
    ? `Permanently remove ${record.email} and all tickets submitted by this account? This also ends their sessions.`
    : `Permanently delete ticket ${record.id}?`;
  $('delete-error').textContent = '';
  deleteDialog.showModal();
}

$('delete-ticket').onclick = () => {
  if (activeDetail?.ticket && !saving) confirmDeletion('tickets', activeDetail.ticket);
};

// Keep the confirmation dialog open while a deletion is in progress.
deleteDialog.oncancel = event => {
  if ($('delete-confirm').disabled) event.preventDefault();
};
// Discard the selected target when the confirmation dialog closes.
deleteDialog.onclose = () => { if (!deleteDialog.open) deleteTarget = null; };
// Send the confirmed admin deletion and refresh the active page. Handle a missing record as already
// removed and keep other errors inside the dialog.
deleteDialog.querySelector('form').onsubmit = async event => {
  if (event.submitter !== $('delete-confirm')) return;
  event.preventDefault();
  const target = deleteTarget;
  if (!target || !adminId || target.session !== client.token || $('delete-confirm').disabled) return;
  $('delete-confirm').disabled = true;
  $('delete-cancel').disabled = true;
  $('delete-error').textContent = '';
  const user = target.collection === 'users';
  let message = user ? 'User removed.' : 'Ticket deleted.';
  try {
    await client.request(`/admin/${target.collection}/${encodeURIComponent(target.id)}`, undefined, 'DELETE');
  } catch (error) {
    if (target.session !== client.token) return;
    if (error.status !== 404) {
      $('delete-error').textContent = errorMessage(error);
      return;
    }
    message = user ? 'This user was already removed.' : 'This ticket was already deleted.';
  } finally {
    $('delete-confirm').disabled = false;
    $('delete-cancel').disabled = false;
  }
  if (target.session !== client.token || !adminId) return;
  deleteDialog.close();
  if (!user && detailDialog.open && target.id === activeDetail?.id) detailDialog.close();
  if (user) $('staff-title').focus();
  notify(message);
  try {
    await openAdminPage();
  } catch (error) {
    if (target.session === client.token) notify(`${message} ${errorMessage(error)}`, true);
  }
};

// Send changed fields with the version originally loaded. On a conflict, reload the latest ticket so
// staff can review it before trying again.
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
  const requestToken = client.token;
  saving = true;
  $('delete-ticket').disabled = true;
  $('edit-save').disabled = true;
  $('edit-fields').disabled = true;
  detailNotice('Saving changes…');
  try {
    const { ticket } = await client.request(path, { ...patch, version: current.version }, 'PATCH');
    if (isCurrent()) {
      renderDetail(detail, ticket);
      detailNotice('Ticket updated.');
    }
    if (requestToken === client.token) {
      try {
        await Promise.all([loadQueue(), loadStats()]);
      } catch {
        if (isCurrent()) detailNotice('Ticket updated. Reload the page to refresh the dashboard.', true);
      }
    }
  } catch (error) {
    if (error.status === 409 && isCurrent()) {
      try {
        const { ticket } = await client.request(path);
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
    $('delete-ticket').disabled = false;
    $('edit-save').disabled = false;
    $('edit-fields').disabled = false;
  }
};

// Discard the active detail request and restore keyboard focus to the queue heading if focus fell back
// to the page.
detailDialog.onclose = () => {
  activeDetail = null;
  if (document.activeElement === document.body && !$('staff').hidden) $('queue-title').focus();
};

// Connect the list controls to either a fresh load or a cursor-based next page.
$('refresh-customer-tickets').onclick = () => void run(() => customerTickets.load());
$('more-customer-tickets').onclick = () => void run(() => customerTickets.loadMore());
$('more-users').onclick = () => void run(() => loadUsers(nextUser), $('more-users'));
$('more-tickets').onclick = () => void run(() => loadQueue(queueFilters, nextQueueTicket));
// Handle reset links and admin navigation when the URL fragment changes.
window.addEventListener('hashchange', () => {
  if (!openResetLink() && document.body.classList.contains('admin-mode')) void run(() => openAdminPage(true));
});
// End the server session and clear the stored token before returning to sign-in.
$('logout').onclick = () => void run(async () => {
  await client.request('/auth/logout', {});
  client.token = null;
  ticketForm.reset();
  show('access');
}, $('logout'));

// At startup, handle a recovery link first. Otherwise, validate any stored session before opening its
// workspace.
if (!openResetLink()) {
  if (client.token) {
    try {
      await openWorkspace((await client.request('/auth/me')).user);
    } catch (error) {
      if ($('staff').hidden && $('customer').hidden) show('access');
      notify(errorMessage(error), true);
    }
  } else {
    show('access');
  }
}
