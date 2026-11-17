const dayMs = 86400000;
const methods = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);

export function trackUsage(db) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS' || !/^\/api(?:\/|$)/i.test(req.path)) return next();
    const started = performance.now();
    const end = res.end;
    let ending = false;

    // Persist before handing the response to the Worker. Work started by a
    // response 'finish' listener can be cancelled when the request completes.
    res.end = function (...args) {
      if (ending) return res;
      ending = true;
      const record = async () => {
        try {
          await db.prepare(`
            INSERT INTO api_requests (user_id, method, route, status_code, duration_ms)
            VALUES (?, ?, ?, ?, ?)
          `).bind(
            res.locals.user?.id ?? null,
            methods.has(req.method) ? req.method : 'OTHER',
            req.route?.path ?? '(unrouted)',
            res.statusCode,
            Math.max(0, Math.round(performance.now() - started))
          ).run();
        } catch (error) {
          // Telemetry failures must not cause a client to retry a completed mutation.
          console.error('API usage write failed', error.name);
        } finally {
          end.apply(res, args);
        }
      };
      void record();
      return res;
    };
    next();
  };
}

export function usageReport(db) {
  return async (req, res) => {
    const days = req.query.days ?? '7';
    if (!['7', '30', '90'].includes(days)) {
      return res.status(400).json({ error: 'Choose a reporting period of 7, 30, or 90 days.' });
    }

    const count = Number(days);
    const today = new Date().toISOString().slice(0, 10);
    const midnight = Date.parse(today + 'T00:00:00Z');
    const dateAt = offset => new Date(midnight + offset * dayMs).toISOString().slice(0, 10);
    const from = dateAt(1 - count);
    const until = dateAt(1);
    const period = 'WHERE r.created_at >= ? AND r.created_at < ?';
    const volume = 'COUNT(*) AS requests, COALESCE(SUM(r.status_code >= 400), 0) AS errors';
    const latency = 'ROUND(AVG(r.duration_ms)) AS avgDurationMs';
    const prepare = sql => db.prepare(sql).bind(from, until);
    const [totals, activity, routes, accounts] = await db.batch([
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
