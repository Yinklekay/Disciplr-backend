const err = { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } }
const json = (d) => ({ description: d, content: { 'application/json': { schema: { type: 'object' } } } })
const verifierQueue = {
  description: "A verifier's pending milestones, soonest first",
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                vaultId: { type: 'string' },
                vaultName: { type: 'string' },
                creator: { type: 'string', nullable: true },
                milestone: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    amount: { type: 'string' },
                    dueDate: { type: 'string', format: 'date-time', nullable: true },
                  },
                },
                overdue: { type: 'boolean' },
                dueInHours: { type: 'integer', nullable: true, description: 'Negative when overdue' },
              },
            },
          },
          count: { type: 'integer' },
        },
      },
    },
  },
}
export const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'Disciplr API', version: '0.1.0', description: 'Commitment vaults on Stellar: lock funds against milestones; a verifier validates progress; funds release on success or redirect on failure.' },
  servers: [{ url: '/api' }],
  paths: {
    '/health': { get: { summary: 'Health check and active data store', responses: { 200: json('OK') } } },
    '/vaults': {
      get: { summary: 'List vaults', parameters: [{ name: 'creator', in: 'query', schema: { type: 'string' } }, { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'completed', 'failed'] } }], responses: { 200: json('Vault list') } },
      post: { summary: 'Create a vault', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['creator', 'verifier', 'amount', 'endDate', 'milestones'], properties: { name: { type: 'string' }, creator: { type: 'string' }, verifier: { type: 'string' }, amount: { type: 'number' }, startDate: { type: 'string', format: 'date-time' }, endDate: { type: 'string', format: 'date-time' }, successDestination: { type: 'string' }, failureDestination: { type: 'string' }, milestones: { type: 'array', items: { type: 'object', required: ['title', 'amount'], properties: { title: { type: 'string' }, amount: { type: 'number' }, dueDate: { type: 'string', format: 'date-time' } } } } } } } } }, responses: { 201: json('Created'), 400: err } },
    },
    '/vaults/{id}': { get: { summary: 'Get a vault with its activity', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json('Vault'), 404: err } } },
    '/verifiers/{address}/queue': {
      get: {
        summary: 'Verifier review queue: pending milestones of active vaults assigned to this verifier',
        parameters: [
          { name: 'address', in: 'path', required: true, schema: { type: 'string', pattern: '^G[A-Z2-7]{55}$' } },
          { name: 'dueWithinDays', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 365, default: 7 }, description: 'Future window; overdue milestones are always included' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        ],
        responses: { 200: verifierQueue, 400: err },
      },
    },
    '/vaults/{id}/milestones/{mid}/validate': { post: { summary: 'Verifier validates a milestone (body: {verifier})', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'mid', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json('Updated vault'), 403: err, 409: err } } },
    '/vaults/{id}/fail': { post: { summary: 'Verifier fails a vault; funds redirect (body: {verifier})', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json('Updated vault'), 403: err, 409: err } } },
    '/transactions': { get: { summary: 'Activity feed (create / validate / release / redirect)', parameters: [{ name: 'vaultId', in: 'query', schema: { type: 'string' } }], responses: { 200: json('Activity') } } },
    '/stats': { get: { summary: 'Aggregate statistics', parameters: [{ name: 'creator', in: 'query', schema: { type: 'string' } }], responses: { 200: json('Stats') } } },
  },
}
