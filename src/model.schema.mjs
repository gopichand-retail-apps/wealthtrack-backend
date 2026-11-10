import { z } from 'zod';

const stringMapSchema = z.record(z.string(), z.string());
const messagesSchema = z
  .object({
    errors: z
      .object({
        invalidRequest: z.string().min(1),
        invalidCsv: z.string().min(1),
        payloadTooLarge: z.string().min(1),
        originNotAllowed: z.string().min(1),
        notFound: z.string().min(1),
        rateLimited: z.string().min(1),
        server: z.string().min(1),
      })
      .strict(),
    reports: stringMapSchema,
    importIssues: stringMapSchema,
    categories: stringMapSchema,
  })
  .catchall(z.string());

const contentModelSchema = z
  .object({
    version: z.number().int().positive(),
    appId: z.literal('wealthtrack'),
    locale: z.string().min(2),
    messages: messagesSchema,
    data: z
      .object({
        app: z
          .object({
            name: z.string().min(1),
            descriptor: z.string().min(1),
            description: z.string().min(1),
            apiBaseUrl: z.string().url(),
            allowedOrigins: z.array(z.string().url()).min(1),
            currency: z.string().length(3),
            timezone: z.string().min(1),
            themeStorageKey: z.string().min(1),
            defaultTheme: z.enum(['light', 'dark']),
          })
          .strict(),
        api: z
          .object({
            rateLimit: z.number().int().positive(),
            rateWindowMs: z.number().int().positive(),
          })
          .strict(),
        navigation: z
          .array(
            z
              .object({
                id: z.enum([
                  'overview',
                  'transactions',
                  'budgets',
                  'goals',
                  'recurring',
                  'import',
                ]),
                label: z.string().min(1),
                icon: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
        periods: z
          .array(
            z
              .object({
                id: z.string().min(1),
                label: z.string().min(1),
                days: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1),
        filters: z
          .object({
            defaultPeriodId: z.string().min(1),
          })
          .strict(),
        categories: z
          .array(
            z
              .object({
                id: z.string().min(1),
                kind: z.enum(['income', 'expense', 'transfer']),
                color: z.string().min(1),
              })
              .strict(),
          )
          .min(1),
        csv: z
          .object({
            headers: z.array(z.string()).length(6),
            maximumRows: z.number().int().positive(),
            maximumBytes: z.number().int().positive(),
            sampleFileName: z.string().min(1),
            templateRows: z.array(z.array(z.string())),
          })
          .strict(),
        seed: z
          .object({
            version: z.number().int().positive(),
            accounts: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    name: z.string().min(1),
                    type: z.string().min(1),
                    currency: z.string().length(3),
                    openingBalanceCents: z.number().int(),
                  })
                  .strict(),
              )
              .min(1),
            transactions: z.array(
              z
                .object({
                  id: z.string().min(1),
                  daysAgo: z.number().int().nonnegative(),
                  description: z.string().min(1),
                  category: z.string().min(1),
                  accountId: z.string().min(1),
                  amountCents: z
                    .number()
                    .int()
                    .refine((amount) => amount !== 0),
                  currency: z.string().length(3),
                })
                .strict(),
            ),
            budgets: z.array(
              z
                .object({
                  id: z.string().min(1),
                  categoryId: z.string().min(1),
                  limitCents: z.number().int().nonnegative(),
                  displayOrder: z.number().int().positive(),
                })
                .strict(),
            ),
            goals: z.array(
              z
                .object({
                  id: z.string().min(1),
                  name: z.string().min(1),
                  savedCents: z.number().int().nonnegative(),
                  targetCents: z.number().int().positive(),
                  targetDate: z.string().min(1),
                  displayOrder: z.number().int().positive(),
                })
                .strict(),
            ),
            bills: z.array(
              z
                .object({
                  id: z.string().min(1),
                  name: z.string().min(1),
                  categoryId: z.string().min(1),
                  amountCents: z.number().int().positive(),
                  accountId: z.string().min(1),
                  cadence: z.string().min(1),
                  dueInDays: z.number().int().nonnegative(),
                  displayOrder: z.number().int().positive(),
                })
                .strict(),
            ),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export function parseWealthTrackModel(value) {
  const envelope = contentModelSchema.parse(value);
  return {
    modelVersion: envelope.version,
    app: { ...envelope.data.app, locale: envelope.locale },
    api: envelope.data.api,
    navigation: envelope.data.navigation,
    copy: envelope.messages,
    periods: envelope.data.periods,
    filters: envelope.data.filters,
    categories: envelope.data.categories,
    csv: envelope.data.csv,
    seed: envelope.data.seed,
  };
}
