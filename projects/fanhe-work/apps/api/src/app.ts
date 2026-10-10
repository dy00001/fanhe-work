import Fastify, { type FastifyInstance } from 'fastify'

/**
 * Build the API instance without starting it. Keeping construction separate
 * from listening lets tests drive the server in process later on.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true })

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'fanhe-api',
    time: new Date().toISOString(),
  }))

  return app
}
