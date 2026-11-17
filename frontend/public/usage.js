const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat();
const percentage = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const date = value => new Date(value + 'T00:00:00Z');
const plural = (value, term) => number.format(value) + ' ' + term + (value === 1 ? '' : 's');

function textSpan(value, className) {
  const span = document.createElement('span');
  span.textContent = value;
  if (className) span.className = className;
  return span;
}

function renderChart(days) {
  const peak = Math.max(...days.map(day => day.requests));
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

  const descriptions = days.map(day => fullDate.format(date(day.date)) + ' · ' + plural(day.requests, 'request') + ' · ' + plural(day.errors, 'error'));
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

function renderTable(body, data, label, emptyMessage) {
  body.replaceChildren();
  if (data.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 3;
    cell.textContent = emptyMessage;
    return;
  }
  for (const entry of data) {
    const row = body.insertRow();
    row.insertCell().append(...label(entry));
    row.insertCell().textContent = number.format(entry.requests);
    row.insertCell().textContent = number.format(entry.errors);
  }
}

function render(report) {
  const { from, to, summary, daily, endpoints, users } = report;
  $('usage-dates').textContent = fullDate.formatRange(date(from), date(to)) + ' · UTC';
  $('metric-requests').textContent = number.format(summary.requests);
  $('metric-error-rate').textContent = summary.requests ? percentage.format(summary.errors / summary.requests) : '—';
  $('metric-errors').textContent = plural(summary.errors, 'failed request');
  $('metric-duration').textContent = summary.avgDurationMs === null ? '—' : number.format(summary.avgDurationMs) + ' ms';
  $('metric-users').textContent = number.format(summary.activeUsers);
  renderChart(daily);
  const more = $('expand-endpoints');
  function showEndpoints(expanded) {
    renderTable($('usage-endpoints'), expanded ? endpoints : endpoints.slice(0, 5),
      entry => [textSpan(entry.method, 'method'), textSpan(entry.route, 'route')], 'No endpoint activity.');
    more.textContent = expanded ? 'Show fewer endpoints' : 'Show all ' + endpoints.length + ' endpoints';
    more.setAttribute('aria-expanded', String(expanded));
  }
  showEndpoints(false);
  more.hidden = endpoints.length <= 5;
  more.onclick = () => showEndpoints(more.getAttribute('aria-expanded') !== 'true');
  renderTable($('usage-callers'), users, entry => [entry.email], 'No identified callers in this period.');
}

export function setupUsageReport(api) {
  let revision = 0;
  const period = $('usage-period');
  const state = $('report-state');
  const refresh = $('usage-refresh');
  function clear() {
    revision++;
    $('usage-data').hidden = true;
    for (const id of ['usage-dates', 'metric-requests', 'metric-error-rate', 'metric-errors', 'metric-duration',
      'metric-users', 'chart-scale', 'chart-bars', 'chart-dates', 'chart-detail', 'usage-endpoints', 'usage-callers']) {
      $(id).replaceChildren();
    }
    $('expand-endpoints').onclick = null;
    state.textContent = '';
    state.classList.remove('error');
    refresh.disabled = false;
  }
  async function load() {
    clear();
    const current = revision;
    state.textContent = 'Loading API usage…';
    refresh.disabled = true;
    try {
      const report = await api('/admin/usage?days=' + period.value);
      if (current !== revision) return;
      render(report);
      $('usage-data').hidden = false;
      state.textContent = '';
    } catch (error) {
      if (current !== revision) return;
      state.textContent = 'Could not load API usage. ' + (error instanceof TypeError ? 'Check your connection and refresh.' : error.message);
      state.classList.add('error');
    } finally {
      if (current === revision) refresh.disabled = false;
    }
  }
  refresh.onclick = period.onchange = () => void load();
  return { load, clear };
}
