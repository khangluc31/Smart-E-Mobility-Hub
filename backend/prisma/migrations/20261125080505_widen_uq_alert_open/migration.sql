-- T-24 / UC-20 E2: one active alert (OPEN or ACKNOWLEDGED) per condition.
DROP INDEX uq_alert_open;
CREATE UNIQUE INDEX uq_alert_open ON alert ("dedupeKey") WHERE status IN ('OPEN', 'ACKNOWLEDGED');
