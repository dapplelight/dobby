-- Installs with a heartbeat in each week (the week starts on Sunday), and how many of them were also active the week before.
WITH w AS (SELECT DISTINCT install, strftime('%Y-%W', day) AS wk, CAST(strftime('%s', day) / 604800 AS INTEGER) AS n FROM events WHERE name = 'heartbeat')
SELECT cur.wk AS week, COUNT(*) AS active, SUM(EXISTS (SELECT 1 FROM w prev WHERE prev.install = cur.install AND prev.n = cur.n - 1)) AS also_active_week_before
FROM w cur GROUP BY cur.wk ORDER BY cur.wk;
