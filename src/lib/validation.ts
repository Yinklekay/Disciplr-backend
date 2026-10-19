import { z, ZodError } from 'zod'
import { StrKey } from '@stellar/stellar-sdk'
import { UserRole } from '../types/user.js'
import { hasTimezoneDesignator, isValidISO8601, parseAndNormalizeToUTC } from '../utils/timestamps.js'


export const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    role: z.nativeEnum(UserRole).optional(),
})

export const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),})

export const refreshSchema = z.object({
  refreshToken: z.string(),
})

export type RegisterInput = z.infer<typeof registerSchema>
export type LoginInput = z.infer<typeof loginSchema>
export type RefreshInput = z.infer<typeof refreshSchema>

const stellarPublicKeySchema = z
  .string()
  .refine(
    (value) => StrKey.isValidEd25519PublicKey(value) || StrKey.isValidMed25519PublicKey(value),
    'must be a valid Stellar public key',
  )

export const utcTimestampSchema = z
  .string({ error: 'required' })
  .superRefine((value, ctx) => {
    if (!hasTimezoneDesignator(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must include timezone (Z or +/-HH:MM)',
      })
      return
    }

    if (!isValidISO8601(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be a valid ISO 8601 timestamp',
      })
    }
  })
  .transform((value, ctx) => {
    if (!isValidISO8601(value)) {
      return z.NEVER
    }

    try {
      return parseAndNormalizeToUTC(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid ISO 8601 timestamp',
      })
      return z.NEVER
    }
  })

/**
 * Allow-list for `PATCH /api/vaults/:id`.
 *
 * Vault ownership fields (`creator`), lifecycle (`status`) and economics
 * (`amount`) are deliberately absent from the editable shape: a PATCH must
 * never be able to redirect settlement destinations, mark a vault complete or
 * change the staked amount. `creator`, `status`, `amount` and `startDate` are
 * declared with `z.never()` so clients receive a field-level error rather than
 * a generic "unrecognized key" message; any other unknown field is rejected by
 * `.strict()`.
 *
 * State-dependent rules (draft-only verifier/destination edits, endDate may
 * only move later, terminal vaults are immutable) are enforced in the route,
 * because they depend on the stored vault.
 */
export const vaultPatchSchema = z
  .object({
    /** Extension of the vault deadline. Must be later than the stored value. */
    endDate: utcTimestampSchema.optional(),
    /** Only editable while the vault is still a draft. */
    verifier: stellarPublicKeySchema.optional(),
    /** Only editable while the vault is still a draft. */
    successDestination: stellarPublicKeySchema.optional(),
    /** Only editable while the vault is still a draft. */
    failureDestination: stellarPublicKeySchema.optional(),
    creator: z.never({ error: 'creator cannot be changed' }).optional(),
    status: z.never({ error: 'status cannot be changed' }).optional(),
    amount: z.never({ error: 'amount cannot be changed' }).optional(),
    startDate: z.never({ error: 'startDate cannot be changed' }).optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'at least one editable field is required',
    path: [],
  })

export type VaultPatchInput = z.infer<typeof vaultPatchSchema>

export const nonEmptyString = z.string().trim().min(1)

export const notificationPayloadSchema = z.object({
  recipient: nonEmptyString,
  subject: nonEmptyString,
  body: nonEmptyString,
})

export const deadlineCheckPayloadSchema = z.object({
  triggerSource: z.enum(['manual', 'scheduler', 'expiration-scheduler']),
  vaultId: z.string().optional(),
  deadlineIso: z.string().optional(),
})

export const milestoneRemindersPayloadSchema = z.object({
  leadTimesMs: z.array(z.number().int().min(0)).optional(),
  limit: z.number().int().min(1).optional(),
})

export const milestoneRemindersDigestPayloadSchema = z.object({
  leadTimesMs: z.array(z.number().int().min(0)).optional(),
  limit: z.number().int().min(1).optional(),
})

export const milestoneRemindersDeferredPayloadSchema = z.object({
  batchSize: z.number().int().min(1).optional(),
})

export const oracleCallPayloadSchema = z.object({
  oracle: nonEmptyString,
  symbol: nonEmptyString,
  requestId: z.string().optional(),
})

export const analyticsRecomputePayloadSchema = z.object({
  scope: z.enum(['global', 'vault', 'user']),
  entityId: z.string().optional(),
  reason: z.string().optional(),
})

export const analyticsReportGeneratePayloadSchema = z.object({
  orgIds: z.array(z.string()).optional(),
})

export const exportGeneratePayloadSchema = z.object({
  exportJobId: nonEmptyString,
})

export const vaultReconcilePayloadSchema = z.object({
  vaultIds: z.array(z.string()).optional(),
  batchSize: z.number().int().min(1).optional(),
})

export const sessionsCleanupPayloadSchema = z.object({
  batchSize: z.number().int().min(1).optional(),
})

export const retentionPurgePayloadSchema = z.object({
  organizationId: nonEmptyString,
  batchSize: z.number().int().min(1).optional(),
})

export const outboxRelayPayloadSchema = z.object({
  batchSize: z.number().int().min(1).optional(),
})

export const embeddingsReindexPayloadSchema = z.object({
  batchSize: z.number().int().min(1).optional(),
  maxBatchesPerRun: z.number().int().min(1).optional(),
})

export const savedSearchEvaluatePayloadSchema = z.object({
  searchId: z.string().optional(),
  batchSize: z.number().int().min(1).optional(),
})

export const enqueueJobSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notification.send'),
    payload: notificationPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('deadline.check'),
    payload: deadlineCheckPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('milestone.reminders'),
    payload: milestoneRemindersPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('milestone.reminders.digest'),
    payload: milestoneRemindersDigestPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('milestone.reminders.deferred'),
    payload: milestoneRemindersDeferredPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('oracle.call'),
    payload: oracleCallPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('analytics.recompute'),
    payload: analyticsRecomputePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('analytics.report.generate'),
    payload: analyticsReportGeneratePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('export.generate'),
    payload: exportGeneratePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('vault.reconcile'),
    payload: vaultReconcilePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('sessions.cleanup'),
    payload: sessionsCleanupPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('retention.purge'),
    payload: retentionPurgePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('outbox.relay'),
    payload: outboxRelayPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('embeddings.reindex'),
    payload: embeddingsReindexPayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
  z.object({
    type: z.literal('saved-search.evaluate'),
    payload: savedSearchEvaluatePayloadSchema,
    maxAttempts: z.number().int().min(1).max(10).optional(),
    delayMs: z.number().int().min(0).max(60000).optional(),
  }),
])

export interface ValidationErrorField {
  path: string
  message: string
  code: string
}

export const formatIssuePath = (path: ReadonlyArray<PropertyKey>): string =>
  path
    .filter((seg): seg is string | number => typeof seg === 'string' || typeof seg === 'number')
    .reduce<string>((acc, seg, i) => {
      if (typeof seg === 'number') return `${acc}[${seg}]`
      return i === 0 ? seg : `${acc}.${seg}`
    }, '')

export const flattenZodErrors = (error: z.ZodError): ValidationErrorField[] =>
  error.issues.map((issue) => ({
    path: formatIssuePath(issue.path) || 'root',
    message: issue.message,
    code: issue.code,
  }))

export const buildValidationError = (fields: ValidationErrorField[]) => ({
  error: {
    code: 'VALIDATION_ERROR',
    message: 'Invalid request payload',
    fields,
  },
})

export const formatValidationError = (error: z.ZodError) => buildValidationError(flattenZodErrors(error))

