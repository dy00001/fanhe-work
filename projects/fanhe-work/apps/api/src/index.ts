import { buildApp } from './app.js'

// Loopback only. The workspace runs on a removable drive, so nothing should be
// reachable from the network during development.
const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '127.0.0.1'

const app = buildApp()

try {
  await app.listen({ port: PORT, host: HOST })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
