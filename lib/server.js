'use strict'

const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const Fastify = require('fastify')
const fastifySwagger = require('@fastify/swagger')
const fastifySwaggerUi = require('@fastify/swagger-ui')
const fastifyCors = require('@fastify/cors')
const fastifyHelmet = require('@fastify/helmet')

const EventBus = require('./event-bus')
const KeepAlive = require('./keep-alive')

const files = [
  'favicon.png',
  'index.html',
  'webhooks.html',
  'main.min.css',
  'main.min.js'
].map(file => fs.readFileSync(path.join(__dirname, '..', 'public', file)))

; (async () => {
  const fastify = Fastify({ logger: true })
  await fastify.register(fastifySwagger)
  await fastify.register(fastifySwaggerUi)
  await fastify.register(fastifyCors)
  await fastify.register(fastifyHelmet)

  const bus = new EventBus({ logger: fastify.log })

  fastify.get('/public/favicon.png', {
    schema: {
      hide: true
    }
  }, async (req, reply) => {
    return reply
      .header('Content-Type', 'image/png')
      .status(200)
      .send(files[0])
  })

  fastify.get('/public/main.min.css', {
    schema: {
      hide: true
    }
  }, async (req, reply) => {
    return reply
      .header('Content-Type', 'text/css; charset=utf-8')
      .status(200)
      .send(files[3])
  })

  fastify.get('/public/main.min.js', {
    schema: {
      hide: true
    }
  }, async (req, reply) => {
    return reply
      .header('Content-Type', 'text/javascript; charset=utf-8')
      .status(200)
      .send(files[4])
  })

  fastify.get('/', {
    schema: {
      hide: true
    }
  }, async (req, reply) => {
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .status(200)
      .send(files[1])
  })

  fastify.get('/new', (req, reply) => {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const channel = crypto.randomBytes(12).toString('base64url')

    reply.redirect(307, `${protocol}://${host}/${channel}`)
  })

  fastify.decorateReply('message_count', 0)

  fastify.decorateReply('ssePing', function () {
    this.raw.write(`id: ${this.message_count++}\nevent: ping\ndata: {}\n\n`)
  })

  fastify.decorateReply('sseReady', function () {
    this.raw.write(`id: ${this.message_count++}\nevent: ready\ndata: {}\n\n`)
  })

  fastify.decorateReply('sse', function (payload, event) {
    this.raw.write(`id: ${this.message_count++}\n${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(payload)}\n\n`)
  })

  // Setup interval to ping every 30 seconds to keep the connection alive
  const keepAlive = new KeepAlive(30000)

  fastify.get('/:channel', async (req, reply) => {
    const { channel } = req.params

    if (req.headers.accept === 'text/event-stream') {
      keepAlive.start(reply)

      reply.raw.socket.setTimeout(0)

      reply
        .raw
        .writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          "x-no-compression": 1
        })

      function close () {
        bus.events.removeListener(channel, reply.sse)
        keepAlive.stop(reply)
        fastify.log.info('Client disconnected', channel, bus.events.listenerCount(channel))
      }

      // Listen for events on this channel
      bus.events.on(channel, reply.send)

      // Clean up when the client disconnects
      reply.raw.on('close', close)

      reply.sseReady()

      fastify.log.info('Client connected to sse', channel, bus.events.listenerCount(channel))
      return
    }

    fastify.log.info('Client connected to web', channel, bus.events.listenerCount(channel))
    return reply
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .send(files[2])
  })

  fastify.post('/:channel', {
    schema: {
      body: {
        type: 'object'
      }
    }
  }, async (req, reply) => {
    // Emit an event to the Redis bus
    await bus.emitEvent({
      channel: req.params.channel,
      payload: {
        ...req.headers,
        body: req.body,
        query: req.query,
        timestamp: Date.now()
      }
    })

    return reply.status(200).send()
  })

  // Resend payload via the event emitter
  fastify.post('/:channel/redeliver', {
    schema: {
      params: {
        type: 'object',
        properties: {
          channel: {
            type: 'string'
          }
        }
      },
      body: {
        type: 'object'
      }
    }
  }, async (req, reply) => {
    // Emit an event to the Redis bus
    await bus.emitEvent({
      channel: req.params.channel,
      payload: req.body
    })
    return reply.status(200)
  })

  if (process.env.SENTRY_DSN) {
    await fastify.register(require('immobiliarelabs/fastify-sentry'), {
      dsn: process.env.SENTRY_DSN,
      environment: 'production',
      release: '1.0.0'
    })
  }

  const port = parseInt(process.env.PORT, 10) || 3000
  fastify.listen({ port }, (err, address) => {
    if (err) {
      console.error(err)
      process.exit(1)
    }
    console.log(`Server listening at ${address}`)
  })
})()
