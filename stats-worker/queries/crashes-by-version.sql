-- Crashes by Dobby version, then the most common kind and place.
SELECT v, COUNT(*) AS crashes, COUNT(DISTINCT install) AS installs FROM crashes GROUP BY v ORDER BY v DESC;

SELECT kind, "where", COUNT(*) AS crashes, COUNT(DISTINCT install) AS installs, group_concat(DISTINCT v) AS versions
FROM crashes GROUP BY kind, "where" ORDER BY crashes DESC LIMIT 20;
