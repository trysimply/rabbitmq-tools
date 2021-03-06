import { v4 as uuid } from 'uuid'
import { Subject } from 'rxjs/Subject'
import curry from 'lodash.curry'
import 'rxjs/add/operator/first'
import 'rxjs/add/operator/partition'

import { connect } from './connection'
import { openChannel } from './channel'
import { Router } from './router'
import * as logging from './logging'

const PUB_OPTIONS = { contentEncoding: 'utf-8', contentType: 'application/json' }

const toBuffer = obj => Buffer.from(JSON.stringify(obj, null, '\t'))

export class ReactiveMQ {
  static create(options) {
    return new ReactiveMQ(options)
  }

  get channelAsPromised() {
    return this.rxChannel
      .filter(channel => channel)
      .first()
      .toPromise()
  }

  get commonOptions() {
    return { logger: this.logger, connectionId: this.connectionId }
  }

  constructor({ appId = 'rx-amqp-client', logger = console, ...options }) {
    this.appId = appId
    this.logger = logger
    this.connectionId = options.connectionId || (options.url && options.url.vhost)
    this.loggingPrefix = this.connectionId ? `Client:${this.connectionId}` : 'Client'

    this.rxConnection = connect(options.url, this.commonOptions)
    this.rxChannel = openChannel(this.rxConnection, this.commonOptions)

    this.replyQueues = new Set()
    this.requests = new Map()
    this.pubOptions = { appId: this.appId, ...PUB_OPTIONS }

    if (options.routerConfig) {
      this.connectRouter(options.routerConfig)
    }

    this.curry()
    this.watchChannel()
  }

  curry() {
    this.request = curry(this._request.bind(this)) // eslint-disable-line no-underscore-dangle
    this.publish = curry(this._publish.bind(this)) // eslint-disable-line no-underscore-dangle
  }

  watchChannel() {
    this.rxChannel
      .filter(channel => !channel)
      .subscribe(() => this.replyQueues.clear())
  }

  async connectRouter(routerConfig) {
    if (this.router) { return }

    if (!routerConfig) {
      throw new Error(`[${this.loggingPrefix}]: "config.routerConfig" is required to start routing`)
    }

    if (routerConfig) {
      this.router = Router.create({
        ...routerConfig,
        ...this.commonOptions,
        appId: this.appId,
        channel: this.rxChannel
      })
    }
  }

  async _request(exchange, replyTo, routingKey, message) {
    const correlationId = uuid()
    this.requests.set(correlationId, new Subject())

    const channel = await this.channelAsPromised
    await channel.assertQueue(replyTo, { exclusive: true })
    this.assertConsume(channel, replyTo, this.resolveReply)

    this.log(logging.formatOutgoingRequest(correlationId, routingKey, this.appId), message)

    channel.publish(exchange, routingKey, toBuffer(message), {
      replyTo,
      correlationId,
      ...this.pubOptions
    })

    return this.requests.get(correlationId).first().toPromise().then(({ data }) => data)
  }

  assertConsume(channel, queue, handler) {
    if (!this.replyQueues.has(queue)) {
      this.replyQueues.add(queue)
      return channel.consume(queue, handler.bind(this), { noAck: true })
    }
    return Promise.resolve(channel)
  }

  resolveReply(message) {
    if (this.requests.has(message.properties.correlationId)) {
      const reply = JSON.parse(message.content.toString())

      this.requests
        .get(message.properties.correlationId)
        .next(reply)

      this.log(logging.formatIncomingResponse(message, reply.error), reply)
    }
  }

  async _publish(exchange, routingKey, message) {
    const channel = await this.channelAsPromised

    this.log(logging.formatEvent(routingKey, this.appId), message)

    return channel.publish(exchange, routingKey, toBuffer(message), this.pubOptions)
  }

  log(message, data) {
    if (!this.logger) { return }

    this.logger.log(logging.formatMeta(this.loggingPrefix, message))

    if (data) {
      this.logger.dir(data, { colors: true, depth: 10 })
    }
  }
}
