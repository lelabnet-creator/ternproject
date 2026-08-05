import { defineConfig } from 'drizzle-kit'
import { loadEnv } from './src/env.js'

loadEnv()

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://tern:tern@localhost:5432/tern',
  },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
