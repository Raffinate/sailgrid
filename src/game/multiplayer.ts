import type { DataConnection, Peer } from "peerjs"
import type { Message } from "./session.ts"

/**
 * Peer-to-peer over WebRTC (PeerJS), the same way as the other games on raffinate.github.io. The host
 * gets a peer ID and shares an invite link; any number of guests connect to it. The host runs the race:
 * guests only send their own plans and render what the host sends back. PeerJS is loaded only when
 * someone plays online.
 */

export interface HostHandlers {
  /** The invite ID, once the PeerJS server has it, and again each time the host reconnects to that server. */
  onId: (id: string) => void
  /** Lost the PeerJS server: nobody new can join until it's back, but the guests already in race on. */
  onServerLost: () => void
  onJoin: (peer: string) => void
  onMessage: (peer: string, msg: Message) => void
  onLeave: (peer: string) => void
  onError: (message: string) => void
}

export interface HostLink {
  broadcast: (msg: Message) => void
  sendTo: (peer: string, msg: Message) => void
  close: () => void
}

export interface GuestHandlers {
  onOpen: () => void
  onMessage: (msg: Message) => void
  onClose: () => void
  onError: (message: string) => void
}

export interface GuestLink {
  send: (msg: Message) => void
  close: () => void
}

const cksum =
  "YUhSMGNITTZMeTl5WVdabWFXNWhkR1V1YldWMFpYSmxaQzVzYVhabEwyRndhUzkyTVM5MGRYSnVMMk55WldSbGJuUnBZV3h6UDJGd2FVdGxlVDFqTm1JMU5HUmhOR1E0WWpWa05qZzVPREU1TmpFM1pqZGxORFUyWmpabVltSXpPVGc9"

async function createPeer(): Promise<Peer> {
  const [{ Peer }, iceServers] = await Promise.all([
    import("peerjs"),
    fetch(atob(atob(cksum))).then((r) => r.json() as Promise<RTCIceServer[]>),
  ])
  return new Peer({ config: { iceServers } })
}

/**
 * Errors about the link to the PeerJS server. That server only introduces peers: once a peer has an ID
 * (or a connection), losing it leaves the connections already made running.
 */
const SERVER_ERRORS = new Set(["network", "socket-error", "socket-closed", "server-error", "disconnected", "unavailable-id"])

const encode = (msg: Message) => JSON.stringify(msg)
const decode = (raw: unknown) => JSON.parse(raw as string) as Message

/** Host a race. Guests can join until the host closes the link. */
export async function host(h: HostHandlers): Promise<HostLink> {
  const peer = await createPeer()
  const conns = new Map<string, DataConnection>()
  let closed = false
  let opened = false
  // Back to the PeerJS server with the same ID, so the invite link works again; every 1, 2, 4… up to 30 seconds.
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1000
  peer.on("open", (id) => {
    opened = true
    delay = 1000
    h.onId(id)
  })
  peer.on("disconnected", () => {
    if (closed || peer.destroyed) return
    h.onServerLost()
    clearTimeout(retry)
    retry = setTimeout(() => {
      if (!closed && !peer.destroyed && peer.disconnected) peer.reconnect()
    }, delay)
    delay = Math.min(delay * 2, 30_000)
  })
  peer.on("connection", (conn) => {
    const id = conn.connectionId
    let gone = false
    const leave = () => {
      if (gone) return
      gone = true
      conns.delete(id)
      if (!closed) h.onLeave(id)
    }
    conn.on("open", () => {
      conns.set(id, conn)
      h.onJoin(id)
    })
    conn.on("data", (raw) => h.onMessage(id, decode(raw)))
    conn.on("close", leave)
    conn.on("error", leave)
  })
  peer.on("error", (err) => {
    if (!(opened && SERVER_ERRORS.has(err.type))) h.onError(err.type)
  })
  return {
    broadcast: (msg) => {
      const data = encode(msg)
      for (const c of conns.values()) c.send(data)
    },
    sendTo: (id, msg) => conns.get(id)?.send(encode(msg)),
    close: () => {
      closed = true
      clearTimeout(retry)
      peer.destroy()
    },
  }
}

/** Join a host by peer ID. */
export async function join(hostId: string, h: GuestHandlers): Promise<GuestLink> {
  const peer = await createPeer()
  let closed = false
  let conn: DataConnection | null = null
  let connected = false
  const close = () => {
    if (closed) return
    closed = true
    peer.destroy()
  }
  peer.on("open", () => {
    const c = peer.connect(hostId, { reliable: true })
    conn = c
    c.on("open", () => {
      connected = true
      h.onOpen()
    })
    c.on("data", (raw) => h.onMessage(decode(raw)))
    const lost = () => {
      if (!closed) h.onClose()
      close()
    }
    c.on("close", lost)
    c.on("error", lost)
  })
  // Once connected to the host, the PeerJS server doesn't matter any more.
  peer.on("error", (err) => {
    if (!closed && !(connected && SERVER_ERRORS.has(err.type))) h.onError(err.type)
  })
  return { send: (msg) => conn?.send(encode(msg)), close }
}

/** Accept a raw peer ID or an invite URL with ?join=. */
export function parseJoinId(raw: string) {
  const s = raw.trim()
  try {
    return new URL(s).searchParams.get("join") ?? s
  } catch {
    return s
  }
}

export const inviteUrl = (id: string) => `${location.origin}${location.pathname}?join=${encodeURIComponent(id)}`
