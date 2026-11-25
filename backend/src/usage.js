import { messages } from './messages.js';
const dayMs = 86400000;
const methods = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);

// Each application owns one usage service. Request timing and completion state stay local
// to each response, so overlapping requests can share the same database connection.
export class ApiUsage {
  #db;

  // Use the application's D1 binding for both request events and dashboard queries.
  constructor(db) {
    this.#db = db;
  }

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
      await this.#db.prepare(
        'INSERT INTO api_requests (user_id, method, route, status_code, duration_ms) ' +
        'VALUES ((SELECT id FROM users WHERE id = ?), ?, ?, ?, ?)'
      ).bind(
        res.locals.user?.id ?? null,
        methods.has(req.method) ? req.method : 'OTHER',
        req.route?.path ?? '(unrouted)',
        res.statusCode,
        Math.max(0, Math.round(performance.now() - started))
      ).run();
    } catch (error) {
      console.error('API usage write failed', error.name);
    }
  }

  // Aggregate activity over a 7-, 30-, or 90-day UTC window, including today.
  // Return totals, daily counts, endpoint activity, and the ten most active identified accounts.
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
    const [totals, activity, routes, accounts] = await this.#db.batch([
      prepare(`SELECT ${volume}, ${latency}, COUNT(DISTINCT r.user_id) AS activeUsers
               FROM api_requests r ${period}`),
      prepare(`SELECT date(r.created_at) AS date, ${volume}
               FROM api_requests r ${period} GROUP BY date(r.created_at)`),
      prepare(`SELECT r.method, r.route, ${volume}, ${latency}
               FROM api_requests r ${period} GROUP BY r.method, r.route
               ORDER BY requests DESC, r.route, r.method`),
      prepare(`SELECT u.email, ${volume}
               FROM api_requests r JOIN users u ON u.id = r.user_id
               ${period} GROUP BY u.id ORDER BY requests DESC, u.email LIMIT 10`)
    ]);

    const activityByDate = new Map(activity.results.map(row => [row.date, row]));
    // Fill gaps in the report with zero-count dates so the chart has a point for every day.
    const daily = Array.from({ length: count }, (_, index) => {
      const date = dateAt(index + 1 - count);
      return activityByDate.get(date) ?? { date, requests: 0, errors: 0 };
    });
    res.json({
      days: count, from, to: today, summary: totals.results[0], daily,
      endpoints: routes.results, users: accounts.results
    });
  };
}
