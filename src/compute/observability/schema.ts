import type { Pool } from 'pg';

export const workerObservabilitySchemaSQL = `
CREATE TABLE IF NOT EXISTS mio_compute_worker_instances (
  instance_id text PRIMARY KEY,
  boot_id uuid, boot_sequence bigint, sequence bigint,
  observed_at timestamptz, received_at timestamptz,
  snapshot jsonb,
  desired_revision bigint NOT NULL DEFAULT 0, desired_limits jsonb,
  desired_command_id uuid, desired_requested_at timestamptz,
  desired_status text CHECK (desired_status IN ('pending','applied','rejected')),
  desired_reason text, desired_confirmed_at timestamptz,
  latest_gap jsonb
);
CREATE TABLE IF NOT EXISTS mio_compute_worker_inbox (
  message_id uuid PRIMARY KEY,
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL, sequence bigint NOT NULL,
  digest text NOT NULL, received_at timestamptz NOT NULL,
  UNIQUE(instance_id,boot_sequence,sequence),
  UNIQUE(instance_id,boot_id,sequence)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_inbox_retention
  ON mio_compute_worker_inbox(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_samples (
  message_id uuid PRIMARY KEY REFERENCES mio_compute_worker_inbox(message_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL,
  sample_at timestamptz NOT NULL, observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  usage jsonb NOT NULL, waiting jsonb NOT NULL, hard jsonb NOT NULL, applied jsonb NOT NULL,
  revision bigint NOT NULL, holds jsonb NOT NULL, gap jsonb
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_instance_time
  ON mio_compute_worker_samples(instance_id,sample_at DESC,received_at DESC,message_id DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_time
  ON mio_compute_worker_samples(sample_at DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_samples_retention
  ON mio_compute_worker_samples(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_events (
  message_id uuid PRIMARY KEY REFERENCES mio_compute_worker_inbox(message_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL, sequence bigint NOT NULL,
  execution_id uuid, event_at timestamptz NOT NULL, received_at timestamptz NOT NULL,
  kind text NOT NULL, detail jsonb NOT NULL, usage jsonb NOT NULL, gap jsonb
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_execution
  ON mio_compute_worker_events(execution_id,sequence) WHERE execution_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_time
  ON mio_compute_worker_events(event_at DESC);
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_gap
  ON mio_compute_worker_events(instance_id,event_at) WHERE gap IS NOT NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_events_retention
  ON mio_compute_worker_events(received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_executions (
  execution_id uuid PRIMARY KEY,
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  boot_id uuid NOT NULL, boot_sequence bigint NOT NULL,
  protocol text NOT NULL, job_id uuid NOT NULL, attempt_id uuid, inspection_id uuid,
  resource text NOT NULL, slots smallint NOT NULL,
  sequence bigint NOT NULL,
  event_state text NOT NULL CHECK (event_state IN ('queued','active','released','cancelled')),
  uncertain boolean NOT NULL DEFAULT false,
  queued_at timestamptz, acquired_at timestamptz, ended_at timestamptz,
  last_at timestamptz NOT NULL, last_received_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_job
  ON mio_compute_worker_executions(job_id,last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_instance
  ON mio_compute_worker_executions(instance_id,last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_time
  ON mio_compute_worker_executions(last_at DESC,execution_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_open
  ON mio_compute_worker_executions(instance_id,boot_sequence)
  WHERE event_state IN ('queued','active') AND NOT uncertain;
CREATE INDEX IF NOT EXISTS mio_compute_worker_executions_retention
  ON mio_compute_worker_executions(last_received_at);
CREATE TABLE IF NOT EXISTS mio_compute_worker_limit_changes (
  command_id uuid PRIMARY KEY, instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  revision bigint NOT NULL, requested_by text NOT NULL, requested_at timestamptz NOT NULL,
  previous_limits jsonb NOT NULL, requested_limits jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
  reason text, applied_limits jsonb, confirmed_at timestamptz, result_observed_at timestamptz,
  result_message_id uuid REFERENCES mio_compute_worker_inbox(message_id),
  UNIQUE(instance_id,revision)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_limit_changes_time
  ON mio_compute_worker_limit_changes(requested_at DESC,command_id);
CREATE INDEX IF NOT EXISTS mio_compute_worker_limit_changes_result
  ON mio_compute_worker_limit_changes(result_message_id) WHERE result_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS mio_compute_worker_control_outbox (
  command_id uuid PRIMARY KEY REFERENCES mio_compute_worker_limit_changes(command_id),
  instance_id text NOT NULL REFERENCES mio_compute_worker_instances(instance_id),
  revision bigint NOT NULL, command jsonb NOT NULL,
  lease_id uuid, lease_until timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL,
  UNIQUE(instance_id,revision)
);
CREATE INDEX IF NOT EXISTS mio_compute_worker_control_pending
  ON mio_compute_worker_control_outbox(instance_id,revision) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS mio_compute_worker_control_sent
  ON mio_compute_worker_control_outbox(sent_at) WHERE sent_at IS NOT NULL;
`;

export async function checkWorkerObservabilitySchema(database: Pick<Pool, 'query'>): Promise<void> {
  await database.query(`
    SELECT message_id, instance_id, boot_id, boot_sequence, sequence, digest, received_at
      FROM mio_compute_worker_inbox LIMIT 0;
    SELECT instance_id, boot_id, boot_sequence, sequence, observed_at, received_at, snapshot,
      desired_revision, desired_limits, desired_command_id, desired_requested_at, desired_status,
      desired_reason, desired_confirmed_at, latest_gap FROM mio_compute_worker_instances LIMIT 0;
    SELECT message_id, instance_id, boot_id, sample_at, observed_at, received_at, usage,
      waiting, hard, applied, revision, holds, gap FROM mio_compute_worker_samples LIMIT 0;
    SELECT message_id, instance_id, boot_id, boot_sequence, sequence, execution_id,
      event_at, received_at, kind, detail, usage, gap FROM mio_compute_worker_events LIMIT 0;
    SELECT execution_id, instance_id, boot_id, boot_sequence, protocol, job_id, attempt_id,
      inspection_id, resource, slots, sequence, event_state, uncertain, queued_at, acquired_at,
      ended_at, last_at, last_received_at FROM mio_compute_worker_executions LIMIT 0;
    SELECT command_id, instance_id, revision, requested_by, requested_at, previous_limits,
      requested_limits, status, reason, applied_limits, confirmed_at, result_observed_at,
      result_message_id FROM mio_compute_worker_limit_changes LIMIT 0;
    SELECT command_id, instance_id, revision, command, lease_id, lease_until, sent_at, created_at
      FROM mio_compute_worker_control_outbox LIMIT 0;
  `);
}
