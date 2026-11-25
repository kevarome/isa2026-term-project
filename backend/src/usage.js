import { messages } from './messages.js';
import { openApi } from './openapi.js';

const dayMs = 86400000;
const freeCalls = 20;
const methods = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);
const apiBase = openApi.servers[0].url;
const registeredEndpoints = Object.entries(openApi.paths).flatMap(([path, operations]) =>
  Object.keys(operations).map(key => key.toUpperCase()).filter(method => methods.has(method)).map(method => ({
    method,
    route: apiBase + path.replace(/\{([^}]+)\}/g, ':$1')
  }))
);

function sendAllowance(res, total) {
  res.locals.callsUsed = total;
  res.set({
    'X-API-Calls-Used': String(total),
    'X-API-Free-Limit': String(freeCalls),
    'X-API-Free-Exceeded': String(total > freeCalls),
    'Access-Control-Expose-Headers': 'X-API-Calls-Used, X-API-Free-Limit, X-API-Free-Exceeded'
  });
}

// Each application owns one usage service. Request timing and completion state stay local
// to each response, so overlapping requests can share the same database connection.
export class ApiUsage {
  #db;

  // Use the application's D1 binding for both request events and dashboard queries.
  constructor(db) {
    this.#db = db;
  }

  // Reserve a single counted call after authentication, before checking roles or executing
  // the requested operation. Concurrent requests each receive their own committed total.
  consume = async (_req, res, next) => {
    const row = await this.#db.prepare(`
      INSERT INTO user_api_consumption (user_id, total)
      SELECT id, 1 FROM users WHERE id = ?
      ON CONFLICT(user_id) DO UPDATE SET total = total + 1
      RETURNING total
    `).bind(res.locals.user.id).first();
    if (!row) return res.status(401).json({ error: messages.signInRequired });
    sendAllowance(res, row.total);
    next();
  };

  // Measure API requests from arrival through response generation, excluding CORS preflights.
  // Finish the write before releasing the response because Workers may suspend background work.
  track = (req, res, next) => {
    if (req.method === 'OPTIONS' || !/^\/api(?:\/|$)/i.test(req.path)) return next();
    const started = performance.now();
    const end = res.end;
    let ending = false;

    // Express can reach end more than once. Persist one event and forward the original arguments.
    res.end = (...args) => {
      if (!ending) {
        ending = true;
        void this.#record(req, res, started).finally(() => end.apply(res, args));
      }
      return res;
    };
    next();
  };

  // Capture the final status, caller and matched route. Using a route template keeps IDs out
  // of the dashboard. A telemetry failure must still let the client receive its original response.
  async #record(req, res, started) {
    try {
      // Login shows the existing allowance without consuming a call.
      if (req.route?.path === '/auth/login' && res.locals.user) {
        const row = await this.#db.prepare('SELECT total FROM user_api_consumption WHERE user_id = ?')
          .bind(res.locals.user.id).first();
        sendAllowance(res, row?.total ?? 0);
      }
      await this.#db.prepare(
        'INSERT INTO api_requests (user_id, method, route, status_code, duration_ms) ' +
        'VALUES ((SELECT id FROM users WHERE id = ?), ?, ?, ?, ?)'
      ).bind(
        res.locals.user?.id ?? null,
        methods.has(req.method) ? req.method : 'OTHER',
        req.route ? apiBase + req.route.path : '(unrouted)',
        res.statusCode,
        Math.max(0, Math.round(performance.now() - started))
      ).run();
    } catch (error) {
      console.error('API usage write failed', error.name);
    }
  }

  // Aggregate activity over a 7-, 30-, or 90-day UTC window, including today.
  // Report all-time endpoint traffic and individual consumption alongside the selected period.
  report = async (req, res) => {
    const days = req.query.days ?? '7';
    if (!['7', '30', '90'].includes(days)) {
      return res.status(400).json({ error: messages.invalidPeriod });
    }

    const count = Number(days);
    const today = new Date().toISOString().slice(0, 10);
    const midnight = Date.parse(today + 'T00:00:00Z');
    // Return the UTC calendar date at the given day offset from today's midnight.
    const dateAt = offset => new Date(midnight + offset * dayMs).toISOString().slice(0, 10);
    const from = dateAt(1 - count);
    const until = dateAt(1);
    const period = 'WHERE r.created_at >= ? AND r.created_at < ?';
    const volume = 'COUNT(*) AS requests, COALESCE(SUM(r.status_code >= 400), 0) AS errors';
    const latency = 'ROUND(AVG(r.duration_ms)) AS avgDurationMs';
    // Bind the shared inclusive start and exclusive end dates to each report query.
    const prepare = sql => this.#db.prepare(sql).bind(from, until);
    const [totals, activity, routes, accounts, lifetimeRoutes, lifetimeUsers] = await this.#db.batch([
      prepare(`SELECT ${volume}, ${latency}, COUNT(DISTINCT r.user_id) AS activeUsers
               FROM api_requests r ${period}`),
      prepare(`SELECT date(r.created_at) AS date, ${volume}
               FROM api_requests r ${period} GROUP BY date(r.created_at)`),
      prepare(`SELECT r.method, r.route, ${volume}, ${latency}
               FROM api_requests r ${period} GROUP BY r.method, r.route
               ORDER BY requests DESC, r.route, r.method`),
      prepare(`SELECT u.email, ${volume}
               FROM api_requests r JOIN users u ON u.id = r.user_id
               ${period} GROUP BY u.id ORDER BY requests DESC, u.email`),
      this.#db.prepare(`SELECT r.method, r.route, ${volume} FROM api_requests r GROUP BY r.method, r.route`),
      this.#db.prepare(`SELECT u.id, u.email, COALESCE(c.total, 0) AS requests
                        FROM users u LEFT JOIN user_api_consumption c ON c.user_id = u.id
                        ORDER BY requests DESC, u.email`)
    ]);

    const recorded = new Map(lifetimeRoutes.results.map(row => [row.method + ' ' + row.route, row]));
    const endpointTotals = registeredEndpoints.map(({ method, route }) =>
      recorded.get(method + ' ' + route) ?? { method, route, requests: 0, errors: 0 }
    ).sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
    const activityByDate = new Map(activity.results.map(row => [row.date, row]));
    // Fill gaps in the report with zero-count dates so the chart has a point for every day.
    const daily = Array.from({ length: count }, (_, index) => {
      const date = dateAt(index + 1 - count);
      return activityByDate.get(date) ?? { date, requests: 0, errors: 0 };
    });
    res.json({
      days: count, from, to: today, summary: totals.results[0], daily,
      endpoints: routes.results, users: accounts.results,
      endpointTotals, userTotals: lifetimeUsers.results
    });
  };
}
