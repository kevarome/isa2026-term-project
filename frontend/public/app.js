import { API_ORIGIN } from './config.js';

const $ = id => document.getElementById(id);
const accessForm = $('access-form');
const ticketForm = $('ticket-form');
const labels = {
  billing: 'Billing', technical: 'Technical', account: 'Account',
  general: 'General Support', low: 'Low', medium: 'Medium', high: 'High'
};
let token = sessionStorage.getItem('ticketmaestro-token');
let registering = false;
let nextUser = null;

function notify(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}

function show(view) {
  for (const id of ['access', 'customer', 'admin']) $(id).hidden = id !== view;
  $('logout').hidden = view === 'access';
}

function saveToken(value) {
  token = value;
  if (value) sessionStorage.setItem('ticketmaestro-token', value);
  else sessionStorage.removeItem('ticketmaestro-token');
}

async function api(path, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(API_ORIGIN + '/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json();
  if (response.status === 401 && token) {
    saveToken(null);
    show('access');
  }
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}

function updateAccessForm() {
  $('access-title').textContent = registering ? 'Create an account' : 'Sign in';
  $('access-submit').textContent = $('access-title').textContent;
  $('access-switch').textContent = registering ? 'Back to sign in' : 'Create an account';
  const password = accessForm.elements.password;
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.minLength = registering ? 12 : 1;
}

function renderTickets({ tickets, usage }) {
  $('usage').textContent = `Ticket submissions: ${usage}`;
  $('tickets').replaceChildren();
  if (!tickets.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No tickets yet.';
    $('tickets').append(empty);
  }
  for (const ticket of tickets) {
    const row = document.createElement('li');
    const status = document.createElement('strong');
    status.textContent = ticket.status === 'manual_review'
      ? 'Awaiting manual review'
      : `${labels[ticket.department]} · ${labels[ticket.urgency]} urgency`;
    const message = document.createElement('p');
    message.textContent = ticket.message;
    row.append(status, message);
    $('tickets').append(row);
  }
}

async function loadUsers(cursor = null) {
  const data = await api('/admin/users' + (cursor ? '?after=' + encodeURIComponent(cursor) : ''));
  if (!cursor) $('users').replaceChildren();
  for (const user of data.users) {
    const row = $('users').insertRow();
    for (const value of [user.email, user.role, user.created_at]) row.insertCell().textContent = value;
  }
  $('totals').textContent = `${data.totals.users} registered · ${data.totals.submissions} ticket submissions`;
  nextUser = data.next;
  $('more-users').hidden = !nextUser;
}

async function openWorkspace(user) {
  if (user.role === 'admin') {
    await loadUsers();
    $('admin-email').textContent = user.email;
    show('admin');
  } else {
    renderTickets(await api('/tickets'));
    $('customer-email').textContent = user.email;
    show('customer');
  }
}

async function run(button, task) {
  button.disabled = true;
  notify();
  try {
    await task();
  } catch (error) {
    notify(error instanceof TypeError ? 'Could not reach the API. Try again.' : error.message, true);
  } finally {
    button.disabled = false;
  }
}

$('access-switch').onclick = () => {
  registering = !registering;
  updateAccessForm();
  notify();
};

accessForm.onsubmit = event => {
  event.preventDefault();
  void run($('access-submit'), async () => {
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
  });
};

$('sample').onclick = () => {
  ticketForm.elements.message.value = 'My internet has been down since this morning, and I need the connection to work from home.';
  ticketForm.elements.message.focus();
};

ticketForm.onsubmit = event => {
  event.preventDefault();
  void run(event.submitter, async () => {
    const message = ticketForm.elements.message;
    message.readOnly = true;
    $('sample').disabled = true;
    try {
      const { ticket } = await api('/tickets', { message: message.value });
      ticketForm.reset();
      const confirmation = ticket.status === 'manual_review'
        ? 'Ticket saved for manual review.'
        : `Ticket routed to ${labels[ticket.department]} with ${labels[ticket.urgency].toLowerCase()} urgency.`;
      notify(confirmation);
      try {
        renderTickets(await api('/tickets'));
      } catch {
        notify(confirmation + ' Refresh the page to reload your tickets.', true);
      }
    } finally {
      message.readOnly = false;
      $('sample').disabled = false;
    }
  });
};

$('more-users').onclick = () => void run($('more-users'), () => loadUsers(nextUser));
$('logout').onclick = () => void run($('logout'), async () => {
  await api('/auth/logout', {});
  saveToken(null);
  ticketForm.reset();
  show('access');
});

if (token) {
  try {
    await openWorkspace((await api('/auth/me')).user);
  } catch (error) {
    show('access');
    notify(error instanceof TypeError ? 'Could not reach the API. Try again.' : error.message, true);
  }
} else {
  show('access');
}
