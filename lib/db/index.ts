import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { getTableName } from 'drizzle-orm'
import { Pool } from 'pg'
import * as schema from './schema'

const globalForDb = globalThis as unknown as {
  __chatzeMemoryStore?: Map<string, any[]>
}

export const inMemoryStore = globalForDb.__chatzeMemoryStore ?? new Map<string, any[]>()
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__chatzeMemoryStore = inMemoryStore
}

function getTableData(table: any): any[] {
  let name = 'default'
  try {
    name = getTableName(table) || 'default'
  } catch {
    name = String(table)
  }
  if (!inMemoryStore.has(name)) {
    inMemoryStore.set(name, [])
  }
  return inMemoryStore.get(name)!
}

function matchesPredicate(row: any, cond: any): boolean {
  if (!cond || !cond.queryChunks) return true

  // Check if wrapped in parentheses: [ "(", SQL, ")" ]
  if (cond.queryChunks.length === 3 && cond.queryChunks[1] && cond.queryChunks[1].queryChunks) {
    return matchesPredicate(row, cond.queryChunks[1])
  }

  // Check if it is a compound OR / AND expression: [ sql1, " or ", sql2, ... ]
  const hasOr = cond.queryChunks.some((c: any) => c && c.value && String(c.value).includes(' or '))
  const hasAnd = cond.queryChunks.some((c: any) => c && c.value && String(c.value).includes(' and '))
  const subQueries = cond.queryChunks.filter((c: any) => c && c.queryChunks)
  if (subQueries.length > 1 && (hasOr || hasAnd)) {
    if (hasOr) return subQueries.some((sq: any) => matchesPredicate(row, sq))
    return subQueries.every((sq: any) => matchesPredicate(row, sq))
  }

  let colName: string | null = null
  let targetVal: any = undefined
  let targetArray: any[] | null = null
  for (const c of cond.queryChunks) {
    if (c && typeof c === 'object' && c.name) {
      colName = c.name
    } else if (c && typeof c === 'object' && 'value' in c) {
      if (Array.isArray(c.value)) {
        targetArray = c.value
      } else {
        targetVal = c.value
      }
    } else if (Array.isArray(c)) {
      targetArray = c
    } else if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
      targetVal = c
    }
  }

  if (colName !== null) {
    const v = row[colName]
    if (targetArray !== null) {
      return targetArray.some((item) => String(item) === String(v))
    }
    if (v === undefined || v === null) return targetVal === null || targetVal === undefined
    if (targetVal instanceof Date && v instanceof Date) return v.getTime() === targetVal.getTime()
    return String(v) === String(targetVal)
  }

  return true
}

function createMockDb(): any {
  const dbInstance: any = {
    select: (_fields?: any) => ({
      from: (table: any) => {
        const queryBuilder: any = {
          where: (predicate: any) => ({
            orderBy: () => ({
              limit: (n: number) => Promise.resolve(getTableData(table).filter((r) => matchesPredicate(r, predicate)).slice(0, n)),
              then: (resolve: any, reject?: any) => Promise.resolve(getTableData(table).filter((r) => matchesPredicate(r, predicate))).then(resolve, reject),
            }),
            limit: (n: number) => Promise.resolve(getTableData(table).filter((r) => matchesPredicate(r, predicate)).slice(0, n)),
            then: (resolve: any, reject?: any) => Promise.resolve(getTableData(table).filter((r) => matchesPredicate(r, predicate))).then(resolve, reject),
          }),
          orderBy: () => ({
            limit: (n: number) => Promise.resolve(getTableData(table).slice(0, n)),
            then: (resolve: any, reject?: any) => Promise.resolve(getTableData(table)).then(resolve, reject),
          }),
          limit: (n: number) => Promise.resolve(getTableData(table).slice(0, n)),
          then: (resolve: any, reject?: any) => Promise.resolve(getTableData(table)).then(resolve, reject),
        }
        return queryBuilder
      },
    }),
    insert: (table: any) => ({
      values: (data: any) => {
        const tableName = getTableName(table) || ''
        const defaultStatus = tableName.includes('request') ? 'pending' : (tableName.includes('friendship') ? 'active' : undefined)
        const items = (Array.isArray(data) ? data : [data]).map((d) => ({
          id: d.id ?? `id_${Math.random().toString(36).slice(2, 10)}`,
          createdAt: d.createdAt ?? new Date(),
          updatedAt: d.updatedAt ?? new Date(),
          ...(defaultStatus ? { status: d.status ?? defaultStatus } : {}),
          ...d,
        }))
        const tbl = getTableData(table)

        const builder: any = {
          returning: () => {
            for (const item of items) tbl.push(item)
            return Promise.resolve(items)
          },
          onConflictDoNothing: () => ({
            returning: () => {
              const inserted: any[] = []
              for (const item of items) {
                const dup = tbl.find((r) =>
                  (item.id && r.id === item.id) ||
                  (item.endpoint && r.endpoint === item.endpoint) ||
                  (item.senderId && item.recipientId && r.senderId === item.senderId && r.recipientId === item.recipientId) ||
                  (item.userAId && item.userBId && r.userAId === item.userAId && r.userBId === item.userBId)
                )
                if (!dup) {
                  tbl.push(item)
                  inserted.push(item)
                }
              }
              return Promise.resolve(inserted)
            },
            then: (resolve: any, reject?: any) => {
              const inserted: any[] = []
              for (const item of items) {
                const dup = tbl.find((r) =>
                  (item.id && r.id === item.id) ||
                  (item.endpoint && r.endpoint === item.endpoint) ||
                  (item.senderId && item.recipientId && r.senderId === item.senderId && r.recipientId === item.recipientId) ||
                  (item.userAId && item.userBId && r.userAId === item.userAId && r.userBId === item.userBId)
                )
                if (!dup) {
                  tbl.push(item)
                  inserted.push(item)
                }
              }
              return Promise.resolve(inserted).then(resolve, reject)
            },
          }),
          onConflictDoUpdate: (config: any) => ({
            returning: () => {
              for (const item of items) {
                const targetField = config?.target?.name || 'endpoint'
                const existing = tbl.find((r) => r[targetField] && r[targetField] === item[targetField])
                if (existing) {
                  Object.assign(existing, config.set || item, { updatedAt: new Date() })
                } else {
                  tbl.push(item)
                }
              }
              return Promise.resolve(items)
            },
            then: (resolve: any, reject?: any) => {
              for (const item of items) {
                const targetField = config?.target?.name || 'endpoint'
                const existing = tbl.find((r) => r[targetField] && r[targetField] === item[targetField])
                if (existing) {
                  Object.assign(existing, config.set || item, { updatedAt: new Date() })
                } else {
                  tbl.push(item)
                }
              }
              return Promise.resolve(items).then(resolve, reject)
            },
          }),
          then: (resolve: any, reject?: any) => {
            for (const item of items) tbl.push(item)
            return Promise.resolve(items).then(resolve, reject)
          },
        }
        return builder
      },
    }),
    update: (table: any) => ({
      set: (updateValues: any) => ({
        where: (predicate: any) => {
          const tbl = getTableData(table)
          const updated: any[] = []
          for (let i = 0; i < tbl.length; i++) {
            if (matchesPredicate(tbl[i], predicate)) {
              tbl[i] = { ...tbl[i], ...updateValues, updatedAt: new Date() }
              updated.push(tbl[i])
            }
          }
          return {
            returning: () => Promise.resolve(updated),
            then: (resolve: any, reject?: any) => Promise.resolve(updated).then(resolve, reject),
          }
        },
      }),
    }),
    delete: (table: any) => ({
      where: (predicate: any) => {
        const tbl = getTableData(table)
        const remaining: any[] = []
        for (let i = 0; i < tbl.length; i++) {
          if (!matchesPredicate(tbl[i], predicate)) {
            remaining.push(tbl[i])
          }
        }
        inMemoryStore.set(getTableName(table) || 'default', remaining)
        return Promise.resolve([])
      },
    }),
    transaction: async (callback: (tx: any) => Promise<any>) => callback(dbInstance),
  }
  return dbInstance
}

let poolInstance: Pool | undefined
let dbInstance: NodePgDatabase<typeof schema> | undefined

if (process.env.DATABASE_URL) {
  try {
    poolInstance = new Pool({ connectionString: process.env.DATABASE_URL })
    dbInstance = drizzle(poolInstance, { schema })
  } catch {
    console.warn('[AI Studio] Database connection failed — using in-memory mock')
  }
}

if (!poolInstance) {
  const mockClient = {
    query: async () => ({ rows: [], rowCount: 0, fields: [] }),
    release: () => {},
  }
  poolInstance = {
    connect: async () => mockClient,
    query: async () => ({ rows: [], rowCount: 0, fields: [] }),
    on: () => {},
    end: async () => {},
  } as unknown as Pool
}

if (!dbInstance) {
  dbInstance = createMockDb() as NodePgDatabase<typeof schema>
}

export const pool: Pool = poolInstance
export const db: NodePgDatabase<typeof schema> = dbInstance

