import { messages } from './messages.js';
// Render the admin usage report with UTC dates so every browser shows the same reporting period.
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// Interpret the API?s calendar date at UTC midnight before formatting it.
const date = value => new Date(value + 'T00:00:00Z');

// Create a span with plain text and an optional class for its visual role.
function textSpan(value, className) {
  const span = document.createElement('span');
  span.textContent = value;
  if (className) span.className = className;
  return span;
}

// Draw one stacked bar per UTC day, with successful and failed requests sharing a scale. Show the empty
// state when the period has no requests.
function renderChart(days) {
  const peak = Math.max(...days.map(day => day.requests));
  $('chart-empty').textContent = messages.noPeriodActivity;
  $('chart-empty').hidden = peak > 0;
  $('traffic-graph').hidden = peak === 0;
  const bars = $('chart-bars');
  bars.replaceChildren();
  if (!peak) return;

  // Pick integer ticks at 1, 2, 5 or 10 times a power of ten.
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, peak / 4)));
  const step = [1, 2, 5, 10].find(value => value * magnitude * 4 >= peak) * magnitude;
  const ceiling = step * 4;
  $('chart-scale').replaceChildren(...[4, 3, 2, 1, 0].map(i => textSpan(number.format(i * step))));
  const axis = $('chart-dates');
  axis.style.gridTemplateColumns = 'repeat(' + days.length + ', minmax(0, 1fr))';
  axis.classList.toggle('dense-axis', days.length > 7);
  const ticks = days.length === 7 ? [0, 2, 4, 6] : [0, Math.floor(days.length / 2), days.length - 1];
  axis.replaceChildren(...ticks.map(index => {
    const label = textSpan(shortDate.format(date(days[index].date)));
    label.style.gridColumn = String(index + 1);
    return label;
  }));

  const descriptions = days.map(day => messages.dailyTraffic(fullDate.format(date(day.date)), day.requests, day.errors));
  // Give the selected bar the chart?s single tab stop and update the text summary for that day.
  function select(index) {
    const previous = bars.querySelector('[tabindex="0"]');
    if (previous) previous.tabIndex = -1;
    bars.children[index].tabIndex = 0;
    $('chart-detail').textContent = descriptions[index];
  }
  for (const [index, day] of days.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-bar';
    button.tabIndex = -1;
    button.setAttribute('aria-label', descriptions[index]);
    const errors = textSpan('', 'bar-error');
    const successes = textSpan('', 'bar-success');
    errors.style.height = (day.errors / ceiling * 100) + '%';
    successes.style.height = ((day.requests - day.errors) / ceiling * 100) + '%';
    button.append(errors, successes);
    button.onfocus = button.onclick = () => select(index);
    button.onpointerenter = () => { $('chart-detail').textContent = descriptions[index]; };
    button.onpointerleave = () => { $('chart-detail').textContent = bars.querySelector('[tabindex="0"]').getAttribute('aria-label'); };
    // Use the arrow, Home, and End keys to navigate within the chart.
    button.onkeydown = event => {
      const destinations = { ArrowLeft: Math.max(0, index - 1), ArrowRight: Math.min(days.length - 1, index + 1), Home: 0, End: days.length - 1 };
      if (!Object.hasOwn(destinations, event.key)) return;
      event.preventDefault();
      bars.children[destinations[event.key]].focus();
    };
    bars.append(button);
  }
  select(days.length - 1);
}

// Show each lifetime total alongside requests and errors for the selected period.
function renderTable(body, data, label, periodEntry, emptyMessage) {
  body.replaceChildren();
  if (data.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 4;
    cell.textContent = emptyMessage;
    return;
  }
  for (const entry of data) {
    const row = body.insertRow();
    row.insertCell().append(...label(entry));
    row.insertCell().textContent = number.format(entry.requests);
    const activity = periodEntry(entry);
    row.insertCell().textContent = number.format(activity?.requests ?? 0);
    row.insertCell().textContent = number.format(activity?.errors ?? 0);
  }
}

// Populate the totals, traffic chart, endpoint table, and identified callers from one API response.
function render(report) {
  const { from, to, summary, daily, endpoints, users, endpointTotals, userTotals } = report;
  $('usage-dates').textContent = fullDate.formatRange(date(from), date(to)) + ' · UTC';
  $('metric-requests').textContent = number.format(summary.requests);
  $('metric-error-rate').textContent = summary.requests ? percentage.format(summary.errors / summary.requests) : '—';
  $('metric-errors').textContent = messages.failedRequests(summary.errors);
  $('metric-duration').textContent = summary.avgDurationMs === null ? '—' : number.format(summary.avgDurationMs) + ' ms';
  $('metric-users').textContent = number.format(summary.activeUsers);
  renderChart(daily);
  const endpointKey = entry => entry.method + ' ' + entry.route;
  const periodEndpoints = new Map(endpoints.map(entry => [endpointKey(entry), entry]));
  const periodUsers = new Map(users.map(entry => [entry.email, entry]));
  const more = $('expand-endpoints');
  // Switch between the first five endpoints and the full list while keeping the accessible expanded
  // state in sync.
  function showEndpoints(expanded) {
    renderTable($('usage-endpoints'), expanded ? endpointTotals : endpointTotals.slice(0, 5),
      entry => [textSpan(entry.method, 'method'), textSpan(entry.route, 'route')],
      entry => periodEndpoints.get(endpointKey(entry)), messages.noActivity);
    more.textContent = expanded ? messages.showFewer : messages.showEndpoints(endpointTotals.length);
    more.setAttribute('aria-expanded', String(expanded));
  }
  showEndpoints(false);
  more.hidden = endpointTotals.length <= 5;
  more.onclick = () => showEndpoints(more.getAttribute('aria-expanded') !== 'true');
  renderTable($('usage-callers'), userTotals,
    entry => [entry.email, textSpan(entry.id, 'usage-account-id')],
    entry => periodUsers.get(entry.email), messages.noCallers);
}

// Owns the active report and ignores responses from a previous page or reporting period.
export class UsageReport {
  #client;
  #revision = 0;
  #period = $('usage-period');
  #state = $('report-state');
  #refresh = $('usage-refresh');

  // Connect the shared API client and reload the report when the controls change or the admin requests
  // a refresh.
  constructor(client) {
    this.#client = client;
    this.#refresh.onclick = this.#period.onchange = () => void this.load();
  }

  // Invalidate pending loads and clear the previous report and its controls when moving between pages
  // or periods.
  clear() {
    this.#revision++;
    $('usage-data').hidden = true;
    for (const id of ['usage-dates', 'metric-requests', 'metric-error-rate', 'metric-errors', 'metric-duration',
      'metric-users', 'chart-scale', 'chart-bars', 'chart-dates', 'chart-detail', 'usage-endpoints', 'usage-callers']) {
      $(id).replaceChildren();
    }
    $('expand-endpoints').onclick = null;
    this.#state.textContent = '';
    this.#state.classList.remove('error');
    this.#refresh.disabled = false;
  }
  // Fetch the selected reporting period. Only the current load can render data, report an error, or
  // re-enable the refresh control.
  async load() {
    this.clear();
    const current = this.#revision;
    this.#state.textContent = messages.loadingUsage;
    this.#refresh.disabled = true;
    try {
      const report = await this.#client.request('/admin/usage?days=' + this.#period.value);
      if (current !== this.#revision) return;
      render(report);
      $('usage-data').hidden = false;
      this.#state.textContent = '';
    } catch (error) {
      if (current !== this.#revision) return;
      this.#state.textContent = messages.usageFailed + (error instanceof TypeError ? messages.retryConnection : error.message);
      this.#state.classList.add('error');
    } finally {
      if (current === this.#revision) this.#refresh.disabled = false;
    }
  }
}
