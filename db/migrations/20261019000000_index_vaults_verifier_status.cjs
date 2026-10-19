/**
 * Index for the verifier review queue (GET /api/verifiers/:address/queue).
 *
 * The queue filters active, non-deleted vaults by verifier, so a partial
 * `(verifier, status)` index keeps that lookup small: only live vaults are
 * indexed. `20260827000000_harden_vault_invariants` already added the wider
 * `idx_vaults_verifier_status_end_date`; this partial index is the tighter
 * match for the queue's access path and avoids duplicating dead rows.
 *
 * Built CONCURRENTLY so deploying the migration does not block writes to
 * `vaults`; hence `transaction: false`.
 */
exports.config = { transaction: false }

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vaults_verifier_status_queue
    ON vaults (verifier, status)
    WHERE deleted_at IS NULL
  `)
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_vaults_verifier_status_queue')
}
