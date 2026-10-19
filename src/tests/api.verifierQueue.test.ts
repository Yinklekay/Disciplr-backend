/**
 * Verifier review queue (issue #1730).
 *
 * `GET /api/verifiers/:address/queue` returns the pending milestones of the
 * active vaults a verifier is responsible for, sorted by due date, with
 * `overdue` / `dueInHours` computed against server time. These tests exercise
 * the deployed Express app end to end against the in-memory store (the same
 * code path used in demo mode), plus the generated Postgres query with a fake
 * pool so we can assert it is a single indexed statement (no N+1).
 *
 * The clock is pinned with a `Date.now` stub so due-hour assertions are exact.
 */
import request from 'supertest'
import { jest } from '@jest/globals'
// @ts-ignore -- plain ESM JavaScript module without type declarations
import app from '../../api/index.mjs'
// @ts-ignore -- plain ESM JavaScript module without type declarations
import { getStore, PgStore } from '../../apilib/store.mjs'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

const VERIFIER_A = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'
const VERIFIER_B = `G${'B'.repeat(55)}`
const CREATOR = `G${'C'.repeat(55)}`
const OTHER = `G${'D'.repeat(55)}`

let store: any
let nowSpy: any

const milestone = (
  id: string,
  dueOffsetMs: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  title: `Milestone ${id}`,
  amount: '100',
  dueDate: iso(NOW + dueOffsetMs),
  status: 'pending',
  ...overrides,
})

const vault = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `Vault ${id}`,
  creator: CREATOR,
  amount: '1000',
  status: 'active',
  startDate: iso(NOW - 10 * DAY),
  endDate: iso(NOW + 60 * DAY),
  verifier: VERIFIER_A,
  successDestination: CREATOR,
  failureDestination: OTHER,
  createdAt: iso(NOW - 10 * DAY),
  updatedAt: iso(NOW - 10 * DAY),
  milestones: [],
  ...overrides,
})

beforeAll(async () => {
  // Force the demo (in-memory) store: the handler must never reach Postgres.
  delete process.env.DATABASE_URL
  store = await getStore()
})

beforeEach(() => {
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW)
  store.vaults = [
    vault('vault-overdue', {
      milestones: [
        milestone('m-overdue', -2 * DAY),
        milestone('m-soon', 3 * DAY),
        milestone('m-later', 30 * DAY),
        milestone('m-done', 1 * DAY, { status: 'completed' }),
      ],
    }),
    vault('vault-window', { milestones: [milestone('m-five-days', 5 * DAY)] }),
    vault('vault-boundary', { milestones: [milestone('m-seven-days', 7 * DAY)] }),
    vault('vault-other-verifier', {
      verifier: VERIFIER_B,
      milestones: [milestone('m-other', 1 * DAY)],
    }),
    vault('vault-completed', {
      status: 'completed',
      milestones: [milestone('m-completed-vault', 1 * DAY)],
    }),
    vault('vault-no-pending', {
      milestones: [milestone('m-already-done', 1 * DAY, { status: 'completed' })],
    }),
  ]
})

afterEach(() => {
  nowSpy.mockRestore()
})

afterAll(() => {
  jest.restoreAllMocks()
})

describe('GET /api/verifiers/:address/queue', () => {
  test('returns only pending milestones of active vaults for that verifier, soonest first', async () => {
    const res = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue`)

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(4)
    expect(res.body.data.map((row: any) => row.milestone.id)).toEqual([
      'm-overdue',
      'm-soon',
      'm-five-days',
      'm-seven-days',
    ])

    // Vault identity travels with each row so the client does not need a second call.
    expect(res.body.data[0]).toMatchObject({
      vaultId: 'vault-overdue',
      vaultName: 'Vault vault-overdue',
      creator: CREATOR,
      overdue: true,
      dueInHours: -48,
      milestone: { id: 'm-overdue', title: 'Milestone m-overdue', amount: '100' },
    })

    // Flags are computed against server time, to the hour.
    const soon = res.body.data.find((row: any) => row.milestone.id === 'm-soon')
    expect(soon.overdue).toBe(false)
    expect(soon.dueInHours).toBe(72)

    // Completed milestones and other verifiers' vaults are excluded.
    const ids = res.body.data.map((row: any) => row.milestone.id)
    expect(ids).not.toContain('m-done')
    expect(ids).not.toContain('m-other')
    expect(ids).not.toContain('m-completed-vault')
    expect(ids).not.toContain('m-later')
  })

  test('dueWithinDays filters future milestones but keeps overdue ones', async () => {
    const zero = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=0`)
    expect(zero.status).toBe(200)
    expect(zero.body.data.map((row: any) => row.milestone.id)).toEqual(['m-overdue'])

    const one = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=1`)
    expect(one.body.data.map((row: any) => row.milestone.id)).toEqual(['m-overdue'])

    const four = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=4`)
    expect(four.body.data.map((row: any) => row.milestone.id)).toEqual(['m-overdue', 'm-soon'])
  })

  test('caps the response at the requested limit', async () => {
    const res = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue?limit=2`)

    expect(res.status).toBe(200)
    expect(res.body.count).toBe(2)
    expect(res.body.data.map((row: any) => row.milestone.id)).toEqual(['m-overdue', 'm-soon'])
  })

  test('only returns vaults assigned to the requested verifier', async () => {
    const res = await request(app).get(`/api/verifiers/${VERIFIER_B}/queue`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      data: [
        expect.objectContaining({ vaultId: 'vault-other-verifier' }),
      ],
      count: 1,
    })
  })

  test('falls back to the vault deadline when a milestone has no dueDate', async () => {
    store.vaults = [
      vault('vault-fallback', {
        endDate: iso(NOW + 4 * DAY),
        milestones: [milestone('m-no-due', 0, { dueDate: null })],
      }),
    ]

    const res = await request(app).get(`/api/verifiers/${VERIFIER_A}/queue`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].milestone.dueDate).toBe(iso(NOW + 4 * DAY))
    expect(res.body.data[0].dueInHours).toBe(96)
  })

  describe('parameter validation', () => {
    test.each([
      ['/api/verifiers/not-an-address/queue', 'address'],
      [`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=abc`, 'dueWithinDays'],
      [`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=-1`, 'dueWithinDays'],
      [`/api/verifiers/${VERIFIER_A}/queue?dueWithinDays=366`, 'dueWithinDays'],
      [`/api/verifiers/${VERIFIER_A}/queue?limit=0`, 'limit'],
      [`/api/verifiers/${VERIFIER_A}/queue?limit=101`, 'limit'],
      [`/api/verifiers/${VERIFIER_A}/queue?limit=1.5`, 'limit'],
    ])('rejects %s with a 400 and details', async (path, field) => {
      const res = await request(app).get(path)

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Validation failed')
      expect(res.body.details.join(' ')).toContain(field)
    })
  })
})

describe('PgStore.listVerifierQueue', () => {
  test('runs one indexed SQL statement with bound params', async () => {
    const rows = [
      {
        vault_id: 'vault-1',
        vault_name: 'Launch',
        creator: CREATOR,
        milestone_id: 'm-1',
        milestone_title: 'Ship it',
        milestone_amount: '250',
        due_at: iso(NOW + DAY),
      },
    ]
    const query = jest.fn().mockResolvedValue({ rows })
    const pgStore = new PgStore({ query })

    const data = await pgStore.listVerifierQueue(VERIFIER_A, { dueWithinDays: 7, limit: 50 })

    // Single query: no per-vault or per-milestone follow-up (N+1).
    expect(query).toHaveBeenCalledTimes(1)

    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('FROM vaults v')
    expect(sql).toContain('JOIN milestones m ON m.vault_id = v.id')
    expect(sql).toContain('v.verifier = $1')
    expect(sql).toContain("v.status = 'active'::vault_status")
    expect(sql).toContain('v.deleted_at IS NULL')
    expect(sql).toContain("m.status = 'pending'::milestone_status")
    expect(sql).toContain('m.deleted_at IS NULL')
    expect(sql).toContain('ORDER BY COALESCE(m.due_date, m.deadline) ASC NULLS LAST')
    expect(sql).toContain('LIMIT $3')

    expect(params).toEqual([VERIFIER_A, iso(NOW + 7 * DAY), 50])

    expect(data).toEqual([
      {
        vaultId: 'vault-1',
        vaultName: 'Launch',
        creator: CREATOR,
        milestone: { id: 'm-1', title: 'Ship it', amount: '250', dueDate: iso(NOW + DAY) },
        overdue: false,
        dueInHours: 24,
      },
    ])
  })

  test('reports overdue rows with negative hours', async () => {
    const rows = [
      {
        vault_id: 'vault-1',
        vault_name: 'Launch',
        creator: CREATOR,
        milestone_id: 'm-1',
        milestone_title: 'Ship it',
        milestone_amount: '250',
        due_at: iso(NOW - 3 * DAY),
      },
    ]
    const query = jest.fn().mockResolvedValue({ rows })
    const pgStore = new PgStore({ query })

    const [row] = await pgStore.listVerifierQueue(VERIFIER_A, { dueWithinDays: 7, limit: 50 })

    expect(row.overdue).toBe(true)
    expect(row.dueInHours).toBe(-72)
  })
})
