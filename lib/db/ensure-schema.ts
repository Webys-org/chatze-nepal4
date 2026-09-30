import { runAutoMigrate } from './auto-migrate'

export function ensureDatabaseSchema(): Promise<void> {
  return runAutoMigrate()
}
