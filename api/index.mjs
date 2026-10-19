// Disciplr public API (Vercel serverless entry). Express app, JSON over HTTP.
import express from 'express'
import cors from 'cors'
import { randomBytes } from 'node:crypto'
import { getStore } from '../apilib/store.mjs'
import { OPENAPI } from '../apilib/openapi.mjs'

const app = express()
app.disable('x-powered-by')
app.use(cors())
app.use(express.json({ limit: '100kb' }))

const STELLAR = /^G[A-Z2-7]{55}$/
const hex = (n) => randomBytes(n).toString('hex')
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg })

/** Parses an optional integer query param, rejecting non-numeric and out-of-range input. */
const boundedInt = (raw, { min, max, fallback }) => {
  if (raw === undefined) return { value: fallback }
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) {
    return { error: `must be an integer between ${min} and ${max}` }
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: `must be an integer between ${min} and ${max}` }
  }
  return { value }
}
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'Internal error' }) })

const router = express.Router()

router.get('/health', wrap(async (_req, res) => {
  const s = await getStore()
  res.json({ status: 'ok', service: 'disciplr-api', store: s.kind, time: new Date().toISOString() })
}))
router.get('/openapi.json', (_req, res) => res.json(OPENAPI))

router.get('/vaults', wrap(async (req, res) => {
  const s = await getStore()
  const vaults = await s.listVaults({ creator: req.query.creator, status: req.query.status })
  res.json({ data: vaults, count: vaults.length })
}))

// A verifier's to-do list: pending milestones of active vaults they are
// responsible for, soonest first, with overdue / due-soon flags computed
// against server time. Without this, a client has to fetch every vault (capped
// at 200) and filter locally, which is both wasteful and wrong past the cap.
router.get('/verifiers/:address/queue', wrap(async (req, res) => {
  const { address } = req.params
  const dueWithinDays = boundedInt(req.query.dueWithinDays, { min: 0, max: 365, fallback: 7 })
  const limit = boundedInt(req.query.limit, { min: 1, max: 100, fallback: 50 })

  const details = []
  if (!STELLAR.test(address)) details.push('address must be a Stellar public key (G..., 56 chars)')
  if (dueWithinDays.error) details.push(`dueWithinDays ${dueWithinDays.error}`)
  if (limit.error) details.push(`limit ${limit.error}`)
  if (details.length) return res.status(400).json({ error: 'Validation failed', details })

  const s = await getStore()
  const data = await s.listVerifierQueue(address, {
    dueWithinDays: dueWithinDays.value,
    limit: limit.value,
  })
  res.json({ data, count: data.length })
}))

router.get('/vaults/:id', wrap(async (req, res) => {
  const s = await getStore()
  const v = await s.getVault(req.params.id)
  if (!v) return bad(res, 'Vault not found', 404)
  res.json({ data: { ...v, activity: await s.listActivity({ vaultId: v.id }) } })
}))

router.post('/vaults', wrap(async (req, res) => {
  const b = req.body || {}
  const errs = []
  if (!STELLAR.test(b.creator || '')) errs.push('creator must be a Stellar public key (G..., 56 chars)')
  if (!STELLAR.test(b.verifier || '')) errs.push('verifier must be a Stellar public key')
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) errs.push('amount must be a positive number')
  const end = new Date(b.endDate); const start = b.startDate ? new Date(b.startDate) : new Date()
  if (isNaN(end) || isNaN(start) || end <= start) errs.push('endDate must be a valid date after startDate')
  const ms = Array.isArray(b.milestones) ? b.milestones : []
  if (ms.length < 1 || ms.length > 20) errs.push('between 1 and 20 milestones are required')
  const milestones = ms.map((m, i) => ({
    id: '', title: String(m?.title || '').trim().slice(0, 200), amount: String(Number(m?.amount)),
    dueDate: new Date(m?.dueDate || b.endDate).toISOString(), status: 'pending', _i: i,
  }))
  milestones.forEach((m, i) => {
    if (!m.title) errs.push(`milestone ${i + 1}: title is required`)
    if (!(Number(m.amount) >= 0)) errs.push(`milestone ${i + 1}: amount must be >= 0`)
    if (isNaN(new Date(m.dueDate))) errs.push(`milestone ${i + 1}: invalid dueDate`)
  })
  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs })
  const id = 'vault-' + hex(6)
  milestones.forEach((m, i) => { m.id = `${id}-m${i + 1}`; delete m._i })
  const now = new Date().toISOString()
  const s = await getStore()
  const vault = {
    id, name: String(b.name || '').trim().slice(0, 200) || `Vault ${amount}`, creator: b.creator, amount: String(amount), status: 'active', startDate: start.toISOString(), endDate: end.toISOString(),
    verifier: b.verifier, successDestination: STELLAR.test(b.successDestination || '') ? b.successDestination : b.creator,
    failureDestination: STELLAR.test(b.failureDestination || '') ? b.failureDestination : b.verifier,
    createdAt: now, updatedAt: now, milestones,
  }
  await s.createVault(vault)
  await s.addActivity({ id: crypto.randomUUID(), type: 'create', vaultId: id, amount: vault.amount, status: 'confirmed', hash: hex(32), memo: 'Vault created', createdAt: now })
  res.status(201).json({ data: vault })
}))

// Verifier validates a milestone. When every milestone is validated the vault completes and funds release.
router.post('/vaults/:id/milestones/:mid/validate', wrap(async (req, res) => {
  const s = await getStore()
  const v = await s.getVault(req.params.id)
  if (!v) return bad(res, 'Vault not found', 404)
  if (v.status !== 'active') return bad(res, `Vault is ${v.status}`, 409)
  if (req.body?.verifier !== v.verifier) return bad(res, 'Only the vault verifier may validate milestones', 403)
  const m = v.milestones.find((x) => x.id === req.params.mid)
  if (!m) return bad(res, 'Milestone not found', 404)
  if (m.status === 'completed') return bad(res, 'Milestone already validated', 409)
  m.status = 'completed'
  const now = new Date().toISOString()
  await s.addActivity({ id: crypto.randomUUID(), type: 'validate', vaultId: v.id, amount: m.amount, status: 'confirmed', hash: hex(32), memo: `Milestone validated: ${m.title}`, createdAt: now })
  if (v.milestones.every((x) => x.status === 'completed')) {
    v.status = 'completed'
    await s.addActivity({ id: crypto.randomUUID(), type: 'release', vaultId: v.id, amount: v.amount, status: 'confirmed', hash: hex(32), memo: 'Funds released to success destination', createdAt: new Date(Date.now() + 1).toISOString() })
  }
  await s.saveVault(v)
  res.json({ data: v })
}))

// Verifier (or creator) declares failure: funds redirect to the failure destination.
router.post('/vaults/:id/fail', wrap(async (req, res) => {
  const s = await getStore()
  const v = await s.getVault(req.params.id)
  if (!v) return bad(res, 'Vault not found', 404)
  if (v.status !== 'active') return bad(res, `Vault is ${v.status}`, 409)
  if (req.body?.verifier !== v.verifier) return bad(res, 'Only the vault verifier may fail a vault', 403)
  v.status = 'failed'
  v.milestones.forEach((m) => { if (m.status !== 'completed') m.status = 'failed' })
  await s.addActivity({ id: crypto.randomUUID(), type: 'redirect', vaultId: v.id, amount: v.amount, status: 'confirmed', hash: hex(32), memo: 'Funds redirected to failure destination', createdAt: new Date().toISOString() })
  await s.saveVault(v)
  res.json({ data: v })
}))

router.get('/transactions', wrap(async (req, res) => {
  const s = await getStore()
  const data = await s.listActivity({ vaultId: req.query.vaultId })
  res.json({ data, count: data.length })
}))

router.get('/stats', wrap(async (req, res) => {
  const s = await getStore()
  const vaults = await s.listVaults({ creator: req.query.creator })
  const sum = (f) => vaults.filter(f).reduce((a, v) => a + Number(v.amount), 0)
  const done = vaults.filter((v) => v.status !== 'active')
  res.json({
    data: {
      totalVaults: vaults.length,
      active: vaults.filter((v) => v.status === 'active').length,
      completed: vaults.filter((v) => v.status === 'completed').length,
      failed: vaults.filter((v) => v.status === 'failed').length,
      totalLocked: sum((v) => v.status === 'active'),
      totalReleased: sum((v) => v.status === 'completed'),
      totalRedirected: sum((v) => v.status === 'failed'),
      successRate: done.length ? Math.round((vaults.filter((v) => v.status === 'completed').length / done.length) * 100) : null,
    },
  })
}))

app.use(['/api/v1', '/api'], router)
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

export default app

if (process.argv[1] && process.argv[1].endsWith('api/index.mjs')) {
  const port = process.env.PORT || 3001
  app.listen(port, () => console.log(`Disciplr API on :${port}`))
}
