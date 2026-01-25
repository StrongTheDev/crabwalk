import WebSocket from 'ws'
import {
  type GatewayFrame,
  type RequestFrame,
  type ResponseFrame,
  type EventFrame,
  type HelloOk,
  type ChatEvent,
  type AgentEvent,
  type SessionInfo,
  type SessionsListParams,
  createConnectParams,
} from './protocol'

type EventCallback = (event: EventFrame) => void

export class ClawdbotClient {
  private ws: WebSocket | null = null
  private requestId = 0
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private eventListeners: EventCallback[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _connected = false

  constructor(
    private url: string = 'ws://127.0.0.1:18789',
    private token?: string
  ) {}

  get connected() {
    return this._connected
  }

  async connect(): Promise<HelloOk> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws?.close()
        reject(new Error('Connection timeout - is clawdbot gateway running?'))
      }, 10000)

      try {
        this.ws = new WebSocket(this.url)
      } catch (e) {
        clearTimeout(timeout)
        reject(new Error(`Failed to create WebSocket: ${e}`))
        return
      }

      this.ws.once('open', () => {
        // Defer to ensure readyState is actually OPEN
        setImmediate(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            const params = createConnectParams(this.token)
            this.ws.send(JSON.stringify(params))
          } else {
            clearTimeout(timeout)
            reject(new Error('WebSocket not ready after open event'))
          }
        })
      })

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg, resolve, reject, timeout)
        } catch (e) {
          console.error('Failed to parse message:', e)
        }
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        console.error('WebSocket error:', err)
        reject(err)
      })

      this.ws.on('close', () => {
        clearTimeout(timeout)
        this._connected = false
        this.scheduleReconnect()
      })
    })
  }

  private handleMessage(
    msg: GatewayFrame | HelloOk,
    connectResolve?: (v: HelloOk) => void,
    _connectReject?: (e: Error) => void,
    connectTimeout?: ReturnType<typeof setTimeout>
  ) {
    if ('type' in msg) {
      switch (msg.type) {
        case 'hello-ok':
          if (connectTimeout) clearTimeout(connectTimeout)
          this._connected = true
          connectResolve?.(msg)
          break

        case 'res':
          this.handleResponse(msg)
          break

        case 'event':
          this.handleEvent(msg)
          break

        case 'req':
          // Server shouldn't send requests to us
          break
      }
    }
  }

  private handleResponse(res: ResponseFrame) {
    const pending = this.pendingRequests.get(res.id)
    if (pending) {
      this.pendingRequests.delete(res.id)
      if (res.ok) {
        pending.resolve(res.payload)
      } else {
        pending.reject(new Error(res.error?.message || 'Request failed'))
      }
    }
  }

  private handleEvent(event: EventFrame) {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (e) {
        console.error('Event listener error:', e)
      }
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(console.error)
    }, 5000)
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected')
    }

    const id = `req-${++this.requestId}`
    const req: RequestFrame = { type: 'req', id, method, params }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      this.ws!.send(JSON.stringify(req))

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id)
          reject(new Error('Request timeout'))
        }
      }, 30000)
    })
  }

  onEvent(callback: EventCallback): () => void {
    this.eventListeners.push(callback)
    return () => {
      const idx = this.eventListeners.indexOf(callback)
      if (idx >= 0) this.eventListeners.splice(idx, 1)
    }
  }

  async listSessions(params?: SessionsListParams): Promise<SessionInfo[]> {
    const result = await this.request<{ sessions: SessionInfo[] }>(
      'sessions.list',
      params
    )
    return result.sessions
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }
}

// Singleton instance for server use
let clientInstance: ClawdbotClient | null = null

export function getClawdbotClient(): ClawdbotClient {
  if (!clientInstance) {
    const token = process.env.CLAWDBOT_API_TOKEN
    clientInstance = new ClawdbotClient('ws://127.0.0.1:18789', token)
  }
  return clientInstance
}

// Parsed event helpers
export function isChatEvent(
  event: EventFrame
): event is EventFrame & { payload: ChatEvent } {
  return event.event === 'chat' && event.payload != null
}

export function isAgentEvent(
  event: EventFrame
): event is EventFrame & { payload: AgentEvent } {
  return event.event === 'agent' && event.payload != null
}
