import { examples, labels, messages, modelNames, reviewReasons } from './messages.js';
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
  return error instanceof TypeError ? messages.networkError : error.message;
}

// Use aria-controls to find the input and keep the button text and accessible label in sync with
// visibility.
function setPasswordVisible(button, visible) {
  $(button.getAttribute('aria-controls')).type = visible ? 'text' : 'password';
  button.textContent = visible ? messages.hide : messages.show;
  button.setAttribute('aria-label', `${button.textContent} ${button.dataset.passwordToggle}`);
}

// Show the form for the selected authentication step. Reset password fields and visibility, and set the
// password requirement and autocomplete hint for sign-in or registration.
function setAccessMode(mode) {
  accessMode = mode;
  const registering = mode === 'register';
  const authenticating = mode === 'login' || registering;
  const title = { login: messages.login, register: messages.register, request: messages.forgotPassword, reset: messages.resetPassword };
  $('access-title').textContent = title[mode];
  accessForm.hidden = !authenticating;
  resetRequestForm.hidden = mode !== 'request';
  resetPasswordForm.hidden = mode !== 'reset';
  $('access-submit').textContent = title[mode];
  $('access-switch').hidden = !authenticating;
  $('access-switch').textContent = registering ? messages.backToLogin : messages.register;
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
    notify(messages.invalidReset, true);
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
  const priorityText = node('span', priority ? messages.priorityLabel(labels[priority]) : labels.unprioritized, 'ticket-priority');
  priorityText.dataset.priority = priority ?? '';
  summary.append(status, node('strong', labels[ticket.department] ?? labels.unassigned), priorityText);
  const message = node('span', ticket.message, 'ticket-preview');
  const identity = ticket.email ? ticket.email + ' · ' : '';
  const meta = node('span', `${identity}${ticket.created_at} UTC`, 'muted ticket-meta');
  const id = node('span', ticket.id, 'ticket-meta ticket-id muted');
  button.append(summary, message);
  if (staff) button.append(node('span', messages.aiClassification(classificationResult(ticket)), 'ticket-classification'));
  button.append(meta, id);
  button.onclick = () => void openTicket(ticket.id, staff);
  row.append(button);
  return row;
}

// Fetch one page of registered accounts. Ignore responses from replaced sessions or newer requests, and
// keep the signed-in admin out of the removal controls.
async function loadUsers(cursor = null) {
  const sessionRevision = client.sessionRevision;
  const request = ++userRequest;
  const data = await client.request('/admin/users' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
  if (sessionRevision !== client.sessionRevision || request !== userRequest || !adminId) return;
  if (!cursor) $('users').replaceChildren();
  for (const user of data.users) {
    const row = $('users').insertRow();
    for (const value of [user.email, user.role, user.created_at]) row.insertCell().textContent = value;
    const actions = row.insertCell();
    if (user.id !== adminId) {
      const remove = node('button', messages.remove, 'danger-action');
      remove.type = 'button';
      remove.setAttribute('aria-label', messages.removeAccount(user.email));
      remove.onclick = () => confirmDeletion('users', user);
      actions.append(remove);
    }
  }
  $('totals').textContent = messages.registeredCount(data.totals.users);
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
  const sessionRevision = client.sessionRevision;
  const isCurrent = () => request === queueRequest && sessionRevision === client.sessionRevision;
  $('queue-state').textContent = messages.loadingTickets;
  $('apply-filters').disabled = true;
  $('more-tickets').disabled = true;
  try {
    const { tickets, next } = await client.request('/tickets?' + query);
    if (!isCurrent()) return;
    const list = $('queue-tickets');
    if (!cursor) list.replaceChildren();
    list.append(...tickets.map(ticket => ticketRow(ticket, true)));
    $('queue-state').textContent = list.childElementCount
      ? messages.ticketsShown(list.childElementCount)
      : messages.noMatches;
    queueFilters = filters;
    nextQueueTicket = next;
    $('more-tickets').hidden = !next;
  } catch (error) {
    if (isCurrent()) {
      $('queue-state').textContent = messages.queueFailed;
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
  const sessionRevision = client.sessionRevision;
  try {
    const stats = await client.request('/stats');
    if (sessionRevision !== client.sessionRevision) return;
    $('stats-total').textContent = messages.ticketCount(stats.total);
    const groups = [
      [messages.department, stats.byDepartment],
      [messages.category, stats.byCategory],
      [messages.status, stats.byStatus],
      [messages.priority, stats.byPriority]
    ];
    $('stats-breakdown').replaceChildren(...groups.map(([heading, counts]) => {
      const group = node('section');
      const list = node('dl');
      list.append(...Object.entries(counts).map(([key, value]) => labeledValue(labels[key] ?? key, value)));
      group.append(node('h3', heading), list);
      return group;
    }));
  } catch (error) {
    if (sessionRevision === client.sessionRevision) $('stats-total').textContent = messages.statsUnavailable;
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
    result.push(messages.suggestedRouting(labels[department], labels[urgency]));
  }
  if (typeof ticket.confidence === 'number') result.push(messages.confidence(percent.format(ticket.confidence)));
  const reason = reviewReasons[ticket.classification_outcome];
  if (reason) result.push(reason);
  return result.join(' · ') || messages.noClassification;
}

// Render the current ticket and keep its latest version for editing. Fill in the routing form and
// original AI result for support users.
function renderDetail(detail, ticket) {
  detail.ticket = ticket;
  $('detail-id').textContent = ticket.id;
  const identity = ticket.email ? ticket.email + ' · ' : '';
  const updated = ticket.updated_at && ticket.updated_at !== ticket.created_at ? messages.updatedAt(ticket.updated_at) : '';
  $('detail-submitted').textContent = identity + messages.submittedAt(ticket.created_at) + updated;
  $('detail-message').textContent = ticket.message;
  const priority = ticketPriority(ticket);
  $('detail-routing').replaceChildren(
    labeledValue(messages.status, labels[ticket.status]),
    labeledValue(messages.department, labels[ticket.department] ?? labels.unassigned),
    labeledValue(messages.priority, labels[priority] ?? labels.unprioritized)
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
  detailNotice(messages.loadingTicket);
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
  const pages = { 'api-usage': messages.apiUsage, 'ticket-queue': messages.queue, 'registered-users': messages.registeredUsers };
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
    $('staff-title').textContent = messages.staffDashboard;
    $('staff-email').textContent = [user.email, labels[user.department]].filter(Boolean).join(' · ');
    $('staff-email').hidden = admin;
    $('admin-email').textContent = admin ? user.email : '';
    $('admin-users').hidden = true;
    $('usage-panel').hidden = true;
    $('staff-queue').hidden = false;
    $('queue-title').textContent = admin ? messages.tickets : messages.queue;
    $('usage-period').value = '7';
    $('users').replaceChildren();
    $('totals').textContent = messages.loadingUsers;
    $('more-users').hidden = true;
    $('queue-tickets').replaceChildren();
    $('more-tickets').hidden = true;
    $('stats-total').textContent = messages.loading;
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

// Register or sign in through the API. Update the session revision on login and clear the password
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
        notify(messages.accountCreated);
        return;
      }
      const result = await client.request('/auth/login', credentials);
      client.changeSession();
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
      if (delivery === 'local') notify(messages.resetLocal);
      else notify(messages.resetEmail);
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
      throw new Error(messages.passwordMismatch);
    }
    $('reset-back').disabled = true;
    try {
      await client.request('/auth/password-reset/confirm', { token: resetToken, password: password.value });
      client.changeSession();
      setAccessMode('login');
      accessForm.elements.email.focus();
      notify(messages.passwordUpdated);
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
    const sessionRevision = client.sessionRevision;
    message.readOnly = true;
    $('ticket-examples').disabled = true;
    notify(messages.submitting);
    try {
      const { ticket } = await client.request('/tickets', { message: message.value });
      if (sessionRevision !== client.sessionRevision) return;
      ticketForm.reset();
      const confirmation = ticket.status === 'manual_review'
        ? messages.queuedForReview
        : messages.routedTo(labels[ticket.department]);
      const saved = messages.savedTicket(confirmation, ticket.id);
      notify(saved);
      try {
        await customerTickets.load();
      } catch {
        notify(saved + messages.refreshHistory, true);
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
  const action = user ? messages.removeUser : messages.deleteTicket;
  deleteTarget = { collection, id: record.id, session: client.sessionRevision };
  $('delete-title').textContent = action + '?';
  $('delete-confirm').textContent = action;
  $('delete-message').textContent = user
    ? messages.confirmRemoveUser(record.email)
    : messages.confirmDeleteTicket(record.id);
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
  if (!target || !adminId || target.session !== client.sessionRevision || $('delete-confirm').disabled) return;
  $('delete-confirm').disabled = true;
  $('delete-cancel').disabled = true;
  $('delete-error').textContent = '';
  const user = target.collection === 'users';
  let message = user ? messages.userRemoved : messages.ticketDeleted;
  try {
    await client.request(`/admin/${target.collection}/${encodeURIComponent(target.id)}`, undefined, 'DELETE');
  } catch (error) {
    if (target.session !== client.sessionRevision) return;
    if (error.status !== 404) {
      $('delete-error').textContent = errorMessage(error);
      return;
    }
    message = user ? messages.alreadyRemoved : messages.alreadyDeleted;
  } finally {
    $('delete-confirm').disabled = false;
    $('delete-cancel').disabled = false;
  }
  if (target.session !== client.sessionRevision || !adminId) return;
  deleteDialog.close();
  if (!user && detailDialog.open && target.id === activeDetail?.id) detailDialog.close();
  if (user) $('staff-title').focus();
  notify(message);
  try {
    await openAdminPage();
  } catch (error) {
    if (target.session === client.sessionRevision) notify(`${message} ${errorMessage(error)}`, true);
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
    detailNotice(messages.noChanges);
    return;
  }
  const path = '/tickets/' + encodeURIComponent(detail.id);
  const isCurrent = () => activeDetail === detail && detailDialog.open;
  const sessionRevision = client.sessionRevision;
  saving = true;
  $('delete-ticket').disabled = true;
  $('edit-save').disabled = true;
  $('edit-fields').disabled = true;
  detailNotice(messages.saving);
  try {
    const { ticket } = await client.request(path, { ...patch, version: current.version }, 'PATCH');
    if (isCurrent()) {
      renderDetail(detail, ticket);
      detailNotice(messages.updated);
    }
    if (sessionRevision === client.sessionRevision) {
      try {
        await Promise.all([loadQueue(), loadStats()]);
      } catch {
        if (isCurrent()) detailNotice(messages.refreshDashboard, true);
      }
    }
  } catch (error) {
    if (error.status === 409 && isCurrent()) {
      try {
        const { ticket } = await client.request(path);
        if (isCurrent()) {
          renderDetail(detail, ticket);
          detailNotice(messages.reviewChanges, true);
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
// Revoke the cookie session before returning to sign-in.
$('logout').onclick = () => void run(async () => {
  await client.request('/auth/logout', {});
  client.changeSession();
  ticketForm.reset();
  show('access');
}, $('logout'));

// An HttpOnly session can only be checked by the API.
if (!openResetLink()) {
  try {
    await openWorkspace((await client.request('/auth/me')).user);
  } catch (error) {
    if ($('staff').hidden && $('customer').hidden) show('access');
    if (error.status !== 401) notify(errorMessage(error), true);
  }
}
