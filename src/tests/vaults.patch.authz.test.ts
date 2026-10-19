/**
 * Route-level tests for the `PATCH /api/vaults/:id` authorization and
 * field allow-list boundary (issue #1718).
 *
 * The route used to forward `req.body` straight into a dynamic UPDATE, so any
 * authenticated user could rewrite `creator`, `status`, `amount`, `verifier`
 * and both payout destinations of any vault. These tests pin the contract:
 *
 * - only the creator or an admin may PATCH, and unauthorised callers get 404
 * - `creator`, `status`, `amount`, `startDate` and unknown keys are 400
 * - verifier/destination edits are draft-only (409 otherwise)
 * - `endDate` may only move later (400 otherwise)
 * - terminal / disputed vaults are 409
 * - successful edits write a `vault.updated` audit entry with old/new values
 */
import express from 'express'
import request from 'supertest'
import { jest } from '@jest/globals'

const mockGetVaultById = jest.fn<any>()
const mockUpdateVaultById = jest.fn<any>()
const mockCreateAuditLog = jest.fn<any>()

// Mutable authenticated principal, set per test. `null` simulates a request
// that reaches the handler without a verified principal.
let authenticatedUser: { userId: string; role: string } | null = {
  userId: 'user-owner',
  role: 'USER',
}

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (authenticatedUser) req.user = authenticatedUser as any
    next()
  },
}))

jest.unstable_mockModule('../middleware/rbac.js', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../middleware/apiKeyAuth.js', () => ({
  requireScopes: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}))

jest.unstable_mockModule('../services/idempotency.js', () => ({
  hashRequestPayload: jest.fn<any>(),
  validateIdempotencyKey: jest.fn<any>(),
  scopeIdempotencyKey: jest.fn<any>(),
}))

jest.unstable_mockModule('../services/vaultCreationIdempotency.js', () => ({
  createVaultIdempotently: jest.fn<any>(),
  VaultCreationIdempotencyConflictError: class extends Error {},
  VaultCreationInProgressError: class extends Error {},
  VaultCreationOwnerError: class extends Error {},
}))

jest.unstable_mockModule('../services/vaultStore.js', () => ({
  createVaultWithMilestones: jest.fn<any>(),
  getVaultById: mockGetVaultById,
  listVaults: jest.fn<any>(),
  cancelVaultById: jest.fn<any>(),
  updateVaultById: mockUpdateVaultById,
  getVaultRevisionById: jest.fn<any>(),
  getVaultETag: jest.fn<any>(),
}))

jest.unstable_mockModule('../services/soroban.js', () => ({
  buildVaultCreationPayload: jest.fn<any>(),
}))

jest.unstable_mockModule('../services/vault.service.js', () => ({
  VaultService: {
    getVaultsByUser: jest.fn<any>().mockResolvedValue([]),
    getVaultById: jest.fn<any>(),
    updateVaultStatus: jest.fn<any>(),
    getVaultTimeline: jest.fn<any>(),
  },
}))

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: mockCreateAuditLog,
}))

jest.unstable_mockModule('../services/analytics.service.js', () => ({
  updateAnalyticsSummary: jest.fn<any>(),
}))

const { vaultsRouter } = await import('../routes/vaults.js')

// Real, checksum-valid Stellar public keys.
const G_VERIFIER = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'
const G_SUCCESS = 'GAT7KQ5MRI34Y5M52Z2GZGQMOAZXUEGPV3U5SERQZQE4HHYBE4SH3X2N'
const G_FAILURE = 'GBWUD4PUYATGWVDMNN3VRQZL45GSY2ZG5QCWNM4AUGYXDCFKMQUF33JU'
const G_NEXT = 'GBKZTSKS2KWKHEF5QGXLSDGBYR5UT6PSHX3U5AI6WLVY7BPCKXVG7AER'

const VAULT_ID = '11111111-1111-4111-8111-111111111111'
const REVISION = '4242'

const baseVault = (overrides: Record<string, unknown> = {}) => ({
  id: VAULT_ID,
  amount: '1000',
  startDate: '2030-01-01T00:00:00.000Z',
  endDate: '2030-06-01T00:00:00.000Z',
  verifier: G_VERIFIER,
  successDestination: G_SUCCESS,
  failureDestination: G_FAILURE,
  creator: 'user-owner',
  status: 'draft',
  createdAt: '2026-01-01T00:00:00.000Z',
  milestones: [],
  lateCheckInWindowSecs: 0,
  ...overrides,
})

const app = express()
app.use(express.json())
app.use('/api/vaults', vaultsRouter)

const patch = (body: unknown, revision: string | null = REVISION) => {
  const req = request(app).patch(`/api/vaults/${VAULT_ID}`)
  if (revision !== null) req.set('x-vault-revision', revision)
  return req.send(body as object)
}

beforeEach(() => {
  jest.clearAllMocks()
  authenticatedUser = { userId: 'user-owner', role: 'USER' }
  mockGetVaultById.mockResolvedValue(baseVault())
  mockUpdateVaultById.mockImplementation(async (_id: string, _revision: string, body: object) => ({
    ...baseVault(),
    ...body,
  }))
  mockCreateAuditLog.mockResolvedValue({ id: 'audit-1' })
})

describe('PATCH /api/vaults/:id — authorization', () => {
  test('an unauthenticated caller is rejected with 401 before any write', async () => {
    authenticatedUser = null

    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('a non-owner gets 404 and the vault is not updated', async () => {
    authenticatedUser = { userId: 'user-attacker', role: 'USER' }

    const res = await patch({ verifier: G_NEXT })

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Vault not found')
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('a missing vault also returns 404 (no existence oracle)', async () => {
    mockGetVaultById.mockResolvedValue(null)

    const res = await patch({ verifier: G_NEXT })

    expect(res.status).toBe(404)
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })

  test('an admin may update a vault they do not own', async () => {
    authenticatedUser = { userId: 'admin-1', role: 'ADMIN' }

    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(mockUpdateVaultById).toHaveBeenCalledTimes(1)
  })

  test('the creator may update their own vault', async () => {
    const res = await patch({
      verifier: G_NEXT,
      successDestination: G_SUCCESS,
      failureDestination: G_FAILURE,
    })

    expect(res.status).toBe(200)
    expect(mockUpdateVaultById).toHaveBeenCalledWith(VAULT_ID, REVISION, {
      verifier: G_NEXT,
      successDestination: G_SUCCESS,
      failureDestination: G_FAILURE,
    })
  })

  test('the optimistic-lock revision header is still required', async () => {
    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' }, null)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('X-Vault-Revision header is required')
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })

  test('a stale revision still surfaces as 409', async () => {
    const conflict = Object.assign(new Error('Vault update conflict'), { status: 409 })
    mockUpdateVaultById.mockRejectedValue(conflict)

    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('Vault update conflict')
  })
})

describe('PATCH /api/vaults/:id — field allow-list', () => {
  test.each([
    ['creator', { creator: 'user-attacker' }, 'creator'],
    ['status', { status: 'completed' }, 'status'],
    ['amount', { amount: '999999' }, 'amount'],
    ['startDate', { startDate: '2030-02-01T00:00:00.000Z' }, 'startDate'],
  ])('rejects %s with a field-level 400', async (_label, body, field) => {
    const res = await patch(body)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    const fields = res.body.error.fields as Array<{ path: string; message: string }>
    expect(fields.some((f) => f.path === field)).toBe(true)
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('rejects unknown keys with 400', async () => {
    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z', surprise: true })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(JSON.stringify(res.body.error.fields)).toContain('surprise')
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })

  test('rejects an empty body', async () => {
    const res = await patch({})

    expect(res.status).toBe(400)
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })

  test('rejects an invalid destination address', async () => {
    const res = await patch({ successDestination: 'not-a-stellar-address' })

    expect(res.status).toBe(400)
    const fields = res.body.error.fields as Array<{ path: string; message: string }>
    expect(fields.some((f) => f.path === 'successDestination')).toBe(true)
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })
})

describe('PATCH /api/vaults/:id — state rules', () => {
  test.each(['verifier', 'successDestination', 'failureDestination'])(
    'rejects %s edits on an active vault with 409',
    async (field) => {
      mockGetVaultById.mockResolvedValue(baseVault({ status: 'active' }))

      const res = await patch({ [field]: G_NEXT })

      expect(res.status).toBe(409)
      expect(String(res.body.error)).toContain('draft')
      expect(mockUpdateVaultById).not.toHaveBeenCalled()
    },
  )

  test('allows a verifier/destination edit on a draft vault', async () => {
    const res = await patch({ verifier: G_NEXT })

    expect(res.status).toBe(200)
    expect(mockUpdateVaultById).toHaveBeenCalledWith(VAULT_ID, REVISION, { verifier: G_NEXT })
  })

  test('allows extending endDate on an active vault', async () => {
    mockGetVaultById.mockResolvedValue(baseVault({ status: 'active' }))

    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(mockUpdateVaultById).toHaveBeenCalledWith(VAULT_ID, REVISION, {
      endDate: '2030-07-01T00:00:00.000Z',
    })
  })

  test.each([
    ['earlier', '2030-05-01T00:00:00.000Z'],
    ['equal', '2030-06-01T00:00:00.000Z'],
  ])('rejects an %s endDate with 400', async (_label, endDate) => {
    mockGetVaultById.mockResolvedValue(baseVault({ status: 'active' }))

    const res = await patch({ endDate })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('endDate can only be extended to a later date')
    expect(mockUpdateVaultById).not.toHaveBeenCalled()
  })

  test.each(['completed', 'failed', 'cancelled', 'disputed'])(
    'rejects edits on a %s vault with 409',
    async (status) => {
      mockGetVaultById.mockResolvedValue(baseVault({ status }))

      const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

      expect(res.status).toBe(409)
      expect(mockUpdateVaultById).not.toHaveBeenCalled()
    },
  )
})

describe('PATCH /api/vaults/:id — audit trail', () => {
  test('writes a vault.updated entry containing the old and new values', async () => {
    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(mockCreateAuditLog).toHaveBeenCalledTimes(1)
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'user-owner',
        action: 'vault.updated',
        target_type: 'vault',
        target_id: VAULT_ID,
        metadata: {
          fields: ['endDate'],
          changes: {
            endDate: {
              from: '2030-06-01T00:00:00.000Z',
              to: '2030-07-01T00:00:00.000Z',
            },
          },
        },
      }),
    )
  })

  test('does not write an audit entry when validation rejects the body', async () => {
    const res = await patch({ status: 'completed' })

    expect(res.status).toBe(400)
    expect(mockCreateAuditLog).not.toHaveBeenCalled()
  })

  test('a failed audit write does not turn a successful update into a 500', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined)
    mockCreateAuditLog.mockRejectedValue(new Error('audit store unavailable'))

    const res = await patch({ endDate: '2030-07-01T00:00:00.000Z' })

    expect(res.status).toBe(200)
    expect(mockUpdateVaultById).toHaveBeenCalledTimes(1)
  })
})
