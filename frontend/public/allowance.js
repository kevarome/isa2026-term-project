// Ignore older totals when requests from the same signed-in session finish out of order.
let latestTotal = -1;

export function showAllowance(headers) {
  const panel = document.getElementById('api-allowance');
  if (!headers) {
    latestTotal = -1;
    panel.hidden = true;
    return;
  }
  if (!headers.has('X-API-Calls-Used') || !headers.has('X-API-Free-Limit')) return;
  const used = Number(headers.get('X-API-Calls-Used'));
  const limit = Number(headers.get('X-API-Free-Limit'));
  if (!Number.isSafeInteger(used) || used < 0 || used < latestTotal ||
      !Number.isSafeInteger(limit) || limit < 0) return;
  latestTotal = used;
  document.getElementById('api-calls-used').textContent = used;
  document.getElementById('api-calls-remaining').textContent = Math.max(0, limit - used);
  document.getElementById('api-limit-warning').hidden = headers.get('X-API-Free-Exceeded') !== 'true';
  panel.hidden = false;
}
