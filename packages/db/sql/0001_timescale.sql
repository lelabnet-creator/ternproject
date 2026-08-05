-- TimescaleDB layer for the `checks` stream.
--
-- Applied after the Drizzle-generated DDL: Drizzle owns table shape, this file
-- owns the time-series behaviour it cannot express (hypertable, continuous
-- aggregates, compression, retention).
--
-- Every statement here must be idempotent — the runner replays this file
-- whenever its checksum changes, and a half-applied migration is worse than a
-- rerun.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS timescaledb_toolkit;

-- ── Hypertable ──────────────────────────────────────────────────────────────
-- One-week chunks: small enough that dropping expired data reclaims space
-- promptly, large enough that a 90-day query touches ~13 chunks, not 90.
SELECT create_hypertable(
  'checks',
  'ts',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists       => TRUE,
  migrate_data        => TRUE
);

-- ── Continuous aggregates ───────────────────────────────────────────────────
-- Three tiers, queried according to the requested window. Uptime is stored as
-- counts rather than a ratio so that coarser tiers can be derived by summing
-- without weighting errors.
--
-- percentile_agg() produces a rollup-able sketch: p95 over an hour is computed
-- from the 1-minute sketches, never by rescanning raw rows. That is the whole
-- reason a 1-year latency chart stays cheap.

CREATE MATERIALIZED VIEW IF NOT EXISTS checks_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', ts) AS bucket,
  tenant_id,
  control_id,
  count(*)                                                   AS samples,
  count(*) FILTER (WHERE status = 'operational')             AS ok_samples,
  count(*) FILTER (WHERE status = 'degraded')                AS degraded_samples,
  count(*) FILTER (WHERE status IN ('down', 'partial'))      AS down_samples,
  count(*) FILTER (WHERE status = 'maintenance')             AS maintenance_samples,
  count(*) FILTER (WHERE status = 'unknown')                 AS unknown_samples,
  avg(latency_ms)                                            AS latency_avg,
  min(latency_ms)                                            AS latency_min,
  max(latency_ms)                                            AS latency_max,
  percentile_agg(latency_ms)                                 AS latency_pct,
  avg(value)                                                 AS value_avg,
  min(value)                                                 AS value_min,
  max(value)                                                 AS value_max
FROM checks
-- Simulation rows never reach the aggregates: a demo must not be able to
-- become someone's published uptime figure.
WHERE synthetic = FALSE
GROUP BY bucket, tenant_id, control_id
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS checks_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '5 minutes', bucket) AS bucket,
  tenant_id,
  control_id,
  sum(samples)              AS samples,
  sum(ok_samples)           AS ok_samples,
  sum(degraded_samples)     AS degraded_samples,
  sum(down_samples)         AS down_samples,
  sum(maintenance_samples)  AS maintenance_samples,
  sum(unknown_samples)      AS unknown_samples,
  avg(latency_avg)          AS latency_avg,
  min(latency_min)          AS latency_min,
  max(latency_max)          AS latency_max,
  rollup(latency_pct)       AS latency_pct,
  avg(value_avg)            AS value_avg,
  min(value_min)            AS value_min,
  max(value_max)            AS value_max
FROM checks_1m
GROUP BY 1, 2, 3
WITH NO DATA;

CREATE MATERIALIZED VIEW IF NOT EXISTS checks_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', bucket) AS bucket,
  tenant_id,
  control_id,
  sum(samples)              AS samples,
  sum(ok_samples)           AS ok_samples,
  sum(degraded_samples)     AS degraded_samples,
  sum(down_samples)         AS down_samples,
  sum(maintenance_samples)  AS maintenance_samples,
  sum(unknown_samples)      AS unknown_samples,
  avg(latency_avg)          AS latency_avg,
  min(latency_min)          AS latency_min,
  max(latency_max)          AS latency_max,
  rollup(latency_pct)       AS latency_pct,
  avg(value_avg)            AS value_avg,
  min(value_min)            AS value_min,
  max(value_max)            AS value_max
FROM checks_5m
GROUP BY 1, 2, 3
WITH NO DATA;

-- ── Refresh policies ────────────────────────────────────────────────────────
-- start_offset bounds the work per run; end_offset leaves the most recent
-- window alone so late-arriving points (a retrying agent draining its queue)
-- still land in the right bucket. The live view reads raw rows anyway, so a
-- one-bucket lag in the aggregates is invisible to users.
SELECT add_continuous_aggregate_policy('checks_1m',
  start_offset => INTERVAL '3 hours',
  end_offset   => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('checks_5m',
  start_offset => INTERVAL '1 day',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE);

SELECT add_continuous_aggregate_policy('checks_1h',
  start_offset => INTERVAL '7 days',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes',
  if_not_exists => TRUE);

-- ── Compression ─────────────────────────────────────────────────────────────
-- Raw rows older than a day are read as history, not as live state.
ALTER TABLE checks SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'control_id',
  timescaledb.compress_orderby   = 'ts DESC'
);

SELECT add_compression_policy('checks', INTERVAL '1 day', if_not_exists => TRUE);

-- ── Retention backstop ──────────────────────────────────────────────────────
-- Per-tenant retention is enforced by the application job, because Timescale
-- policies act per hypertable and tenants configure different windows. This
-- policy only guarantees that nothing survives past the longest window the
-- product allows (2 years) even if that job never runs.
SELECT add_retention_policy('checks', INTERVAL '740 days', if_not_exists => TRUE);

-- ── Query helpers ───────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS checks_1m_control_bucket_idx
  ON checks_1m (control_id, bucket DESC);
CREATE INDEX IF NOT EXISTS checks_5m_control_bucket_idx
  ON checks_5m (control_id, bucket DESC);
CREATE INDEX IF NOT EXISTS checks_1h_control_bucket_idx
  ON checks_1h (control_id, bucket DESC);
