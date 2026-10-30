-- Installs that reached each step of setup and the first-use milestones (each is sent once per install).
SELECT name, COUNT(DISTINCT install) AS installs FROM events
WHERE name IN ('setup_started','setup_done','first_ticket','first_pr','first_merge','first_week_report')
GROUP BY name ORDER BY installs DESC;

-- Setup steps: how many passed and how many did not, with the reason.
SELECT json_extract(props,'$.step') AS step, json_extract(props,'$.ok') AS ok, json_extract(props,'$.reason') AS reason, COUNT(DISTINCT install) AS installs
FROM events WHERE name = 'setup_step' GROUP BY step, ok, reason ORDER BY step, ok DESC, installs DESC;
