// Data store for the deployed Disciplr API.
// - If DATABASE_URL is set, uses Postgres (the real `vaults` / `milestones` tables created by
//   `npm run migrate:latest`, plus an `activity_log` table created on first use).
// - Otherwise falls back to an in-memory demo store (state resets on cold start).
import { randomUUID, randomBytes } from 'node:crypto'

const DAY = 86400000
const HOUR = 3600000
const iso = (d) => new Date(d).toISOString()
const hex = (n) => randomBytes(n).toString('hex')

/**
 * Shapes one verifier-queue row. Flags are computed against `now` (server time)
 * so the API and any client clock cannot disagree about what is overdue.
 */
const queueItem = ({ vaultId, vaultName, creator, milestone, dueMs, now }) => ({
  vaultId,
  vaultName: vaultName || `Vault ${vaultId}`,
  creator: creator || null,
  milestone: {
    id: milestone.id,
    title: milestone.title,
    amount: String(Number(milestone.amount)),
    dueDate: dueMs === null ? null : iso(dueMs),
  },
  overdue: dueMs !== null && dueMs < now,
  // Nearest whole hour; negative values mean the milestone is already late.
  dueInHours: dueMs === null ? null : Math.round((dueMs - now) / HOUR),
})

function seed() {
  const now = Date.now()
  const mk = (id, name, creator, amount, status, startOff, endOff, ms) => ({
    id, name, creator, amount: String(amount), status,
    startDate: iso(now + startOff * DAY), endDate: iso(now + endOff * DAY),
    verifier: 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2',
    successDestination: creator, failureDestination: 'GCAJ2QOEXTR7AB5PJXSAO2HEISE2VEIUIX7CP3F3MOYVX7GMADB7KX22',
    createdAt: iso(now + startOff * DAY), updatedAt: iso(now + startOff * DAY),
    milestones: ms.map((m, i) => ({ id: `${id}-m${i + 1}`, title: m[0], amount: String(m[1]), dueDate: iso(now + m[2] * DAY), status: m[3] })),
  })
  const creator = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
  const vaults = [
    mk('vault-demo-001', 'Launch the MVP', creator, 2500, 'active', -20, 40, [['Ship MVP', 1000, 10, 'completed'], ['Reach 100 users', 1000, 25, 'pending'], ['Public launch', 500, 40, 'pending']]),
    mk('vault-demo-002', 'Finish the thesis', creator, 800, 'completed', -60, -5, [['Finish thesis draft', 400, -30, 'completed'], ['Submit thesis', 400, -5, 'completed']]),
    mk('vault-demo-003', 'Run 3x per week', creator, 1200, 'failed', -90, -10, [['Run 3x per week for 8 weeks', 1200, -10, 'failed']]),
  ]
  const activity = [
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-001', amount: '2500', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[0].createdAt },
    { id: randomUUID(), type: 'validate', vaultId: 'vault-demo-001', amount: '1000', status: 'confirmed', hash: hex(32), memo: 'Milestone validated: Ship MVP', createdAt: iso(now - 8 * DAY) },
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-002', amount: '800', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[1].createdAt },
    { id: randomUUID(), type: 'release', vaultId: 'vault-demo-002', amount: '800', status: 'confirmed', hash: hex(32), memo: 'Funds released to success destination', createdAt: iso(now - 5 * DAY) },
    { id: randomUUID(), type: 'create', vaultId: 'vault-demo-003', amount: '1200', status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: vaults[2].createdAt },
    { id: randomUUID(), type: 'redirect', vaultId: 'vault-demo-003', amount: '1200', status: 'confirmed', hash: hex(32), memo: 'Funds redirected to failure destination', createdAt: iso(now - 10 * DAY) },
  ]
  return { vaults, activity }
}

export class MemoryStore {
  kind = 'memory'
  constructor() { const s = seed(); this.vaults = s.vaults; this.activity = s.activity }
  async init() {}
  async listVaults({ creator, status } = {}) {
    return this.vaults.filter((v) => (!creator || v.creator === creator) && (!status || v.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  /**
   * Pending milestones of active vaults assigned to `verifier`.
   *
   * Equivalent to the Postgres query in `PgStore.listVerifierQueue`: overdue
   * milestones are always included, `dueWithinDays` bounds the future window,
   * milestones with neither `dueDate` nor a vault deadline sort last.
   */
  async listVerifierQueue(verifier, { dueWithinDays = 7, limit = 50 } = {}) {
    const now = Date.now()
    const cutoff = now + dueWithinDays * DAY
    const items = []

    for (const vault of this.vaults) {
      if (vault.status !== 'active' || vault.verifier !== verifier) continue
      for (const milestone of vault.milestones || []) {
        if (milestone.status !== 'pending') continue
        const dueDate = milestone.dueDate || vault.endDate || null
        const dueMs = dueDate ? new Date(dueDate).getTime() : null
        if (dueMs !== null && dueMs > cutoff) continue
        items.push(queueItem({
          vaultId: vault.id,
          vaultName: vault.name,
          creator: vault.creator,
          milestone,
          dueMs,
          now,
        }))
      }
    }

    items.sort((a, b) => {
      const at = a.milestone.dueDate ? Date.parse(a.milestone.dueDate) : Infinity
      const bt = b.milestone.dueDate ? Date.parse(b.milestone.dueDate) : Infinity
      return at - bt
    })

    return items.slice(0, limit)
  }
  async getVault(id) { return this.vaults.find((v) => v.id === id) || null }
  async createVault(v) { this.vaults.push(v); return v }
  async saveVault(v) { v.updatedAt = iso(Date.now()); return v }
  async addActivity(a) { this.activity.push(a); return a }
  async listActivity({ vaultId } = {}) {
    return this.activity.filter((a) => !vaultId || a.vaultId === vaultId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
}

export class PgStore {
  kind = 'postgres'
  constructor(pool) { this.pool = pool }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS activity_log (
      id uuid PRIMARY KEY, type text NOT NULL, vault_id text NOT NULL, amount numeric(36,7) NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'confirmed', hash text NOT NULL, memo text, created_at timestamptz NOT NULL DEFAULT now())`)
    await this.pool.query('ALTER TABLE vaults ADD COLUMN IF NOT EXISTS name varchar(200)')
    for (const v of seed().vaults) {
      await this.pool.query('UPDATE vaults SET name=$2 WHERE id=$1 AND name IS NULL', [v.id, v.name])
      await this.pool.query('UPDATE vaults SET creator=$2, verifier=$3, success_destination=$4, failure_destination=$5 WHERE id=$1 AND creator<>$2',
        [v.id, v.creator, v.verifier, v.successDestination, v.failureDestination])
    }
    const { rows } = await this.pool.query('SELECT count(*)::int AS n FROM vaults')
    if (rows[0].n === 0) {
      const s = seed()
      for (const v of s.vaults) await this.createVault(v)
      for (const a of s.activity) await this.addActivity(a)
    }
  }
  rowToVault(r, ms) {
    return {
      id: r.id, name: r.name || `Vault ${r.id}`, creator: r.creator, amount: String(Number(r.amount)), status: r.status, startDate: iso(r.start_date), endDate: iso(r.end_date),
      verifier: r.verifier, successDestination: r.success_destination, failureDestination: r.failure_destination,
      createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
      milestones: ms.filter((m) => m.vault_id === r.id).sort((a, b) => a.sort_order - b.sort_order)
        .map((m) => ({ id: m.id, title: m.title, amount: String(Number(m.amount)), dueDate: iso(m.due_date || m.deadline), status: m.status })),
    }
  }
  async listVaults({ creator, status } = {}) {
    const w = ['deleted_at IS NULL']; const p = []
    if (creator) { p.push(creator); w.push(`creator = $${p.length}`) }
    if (status) { p.push(status); w.push(`status = $${p.length}::vault_status`) }
    const { rows } = await this.pool.query(`SELECT * FROM vaults WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, p)
    if (!rows.length) return []
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = ANY($1) AND deleted_at IS NULL', [rows.map((r) => r.id)])).rows
    return rows.map((r) => this.rowToVault(r, ms))
  }
  /**
   * Pending milestones of active vaults assigned to `verifier`, ordered by due
   * date. One indexed query, no N+1: callers get exactly the rows they render.
   *
   * `dueWithinDays` bounds the future window, but milestones already overdue
   * are always returned (`due_at <= now + window`). Rows with neither a due
   * date nor a deadline are returned last so nothing silently disappears.
   */
  async listVerifierQueue(verifier, { dueWithinDays = 7, limit = 50 } = {}) {
    const now = Date.now()
    const horizon = iso(now + dueWithinDays * DAY)
    const { rows } = await this.pool.query(
      `SELECT v.id AS vault_id, v.name AS vault_name, v.creator,
              m.id AS milestone_id, m.title AS milestone_title, m.amount AS milestone_amount,
              COALESCE(m.due_date, m.deadline) AS due_at
         FROM vaults v
         JOIN milestones m ON m.vault_id = v.id
        WHERE v.verifier = $1
          AND v.status = 'active'::vault_status
          AND v.deleted_at IS NULL
          AND m.status = 'pending'::milestone_status
          AND m.deleted_at IS NULL
          AND (COALESCE(m.due_date, m.deadline) IS NULL
               OR COALESCE(m.due_date, m.deadline) <= $2::timestamptz)
        ORDER BY COALESCE(m.due_date, m.deadline) ASC NULLS LAST
        LIMIT $3`,
      [verifier, horizon, limit],
    )

    return rows.map((r) => {
      const dueMs = r.due_at === null || r.due_at === undefined ? null : new Date(r.due_at).getTime()
      return queueItem({
        vaultId: r.vault_id,
        vaultName: r.vault_name,
        creator: r.creator,
        milestone: { id: r.milestone_id, title: r.milestone_title, amount: r.milestone_amount },
        dueMs,
        now,
      })
    })
  }
  async getVault(id) {
    const { rows } = await this.pool.query('SELECT * FROM vaults WHERE id = $1 AND deleted_at IS NULL', [id])
    if (!rows[0]) return null
    const ms = (await this.pool.query('SELECT * FROM milestones WHERE vault_id = $1 AND deleted_at IS NULL', [id])).rows
    return this.rowToVault(rows[0], ms)
  }
  async createVault(v) {
    const c = await this.pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO vaults (id, name, creator, amount, start_date, end_date, verifier, success_destination, failure_destination, status, created_at, updated_at)
        VALUES ($1,$11,$2,$3,$4,$5,$6,$7,$8,$9::vault_status,$10,$10)`,
      [v.id, v.creator, v.amount, v.startDate, v.endDate, v.verifier, v.successDestination, v.failureDestination, v.status, v.createdAt, v.name])
      let i = 0
      for (const m of v.milestones) {
        await c.query(`INSERT INTO milestones (id, vault_id, title, target_amount, amount, deadline, due_date, status, sort_order)
          VALUES ($1,$2,$3,$4,$4,$5,$5,$6::milestone_status,$7)`, [m.id, v.id, m.title, m.amount, m.dueDate, m.status, i++])
      }
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
    return v
  }
  async saveVault(v) {
    await this.pool.query('UPDATE vaults SET status=$2::vault_status, updated_at=now() WHERE id=$1', [v.id, v.status])
    for (const m of v.milestones) await this.pool.query('UPDATE milestones SET status=$2::milestone_status, updated_at=now() WHERE id=$1', [m.id, m.status])
    return v
  }
  async addActivity(a) {
    await this.pool.query('INSERT INTO activity_log (id,type,vault_id,amount,status,hash,memo,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [a.id, a.type, a.vaultId, a.amount, a.status, a.hash, a.memo, a.createdAt])
    return a
  }
  async listActivity({ vaultId } = {}) {
    const { rows } = vaultId
      ? await this.pool.query('SELECT * FROM activity_log WHERE vault_id=$1 ORDER BY created_at DESC LIMIT 200', [vaultId])
      : await this.pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 200')
    return rows.map((r) => ({ id: r.id, type: r.type, vaultId: r.vault_id, amount: String(Number(r.amount)), status: r.status, hash: r.hash, memo: r.memo, createdAt: iso(r.created_at) }))
  }
}

let storePromise
export function getStore() {
  if (!storePromise) {
    storePromise = (async () => {
      let store
      const url = process.env.DATABASE_URL
      if (url) {
        try {
          const pg = (await import('pg')).default
          const pool = new pg.Pool({ connectionString: url, max: 3, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } })
          store = new PgStore(pool)
          await store.init()
        } catch (e) {
          console.error('Postgres unavailable, falling back to in-memory store:', e.message)
          store = null
        }
      }
      if (!store) { store = new MemoryStore(); await store.init() }
      return store
    })()
  }
  return storePromise
}
