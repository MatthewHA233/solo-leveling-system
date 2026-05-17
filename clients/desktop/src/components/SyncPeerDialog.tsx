// ══════════════════════════════════════════════
// SyncPeerDialog — 局域网同步浮层
//   · 模型：建立"链接关系"后，启动即自动双向同步
//   · 已链接 ↔ 附近未链接 两段卡片，链接卡片显示同步状态/时间
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Check,
  ChevronRight,
  Globe,
  Link2,
  Link2Off,
  Monitor,
  Pencil,
  Plug,
  RefreshCw,
  RotateCw,
  Server,
  Smartphone,
  Wifi,
  X,
} from 'lucide-react'
import {
  addSyncLink,
  discoverSyncPeers,
  fetchSyncHello,
  fetchSyncLinks,
  fetchSyncPeers,
  removeSyncLink,
  runSyncLink,
  setLocalSyncAlias,
} from '../lib/local-api'
import type { LinkedDevice, SyncHello, SyncPeer } from '../lib/local-api'
import { theme } from '../theme'
import { HudFrame } from './hud'
import Tooltip from './Tooltip'

interface Props {
  readonly open: boolean
  readonly onClose: () => void
  readonly anchorRect?: DOMRect | null
}

function peerBaseUrl(peer: SyncPeer): string {
  return `${peer.protocol || 'http'}://${peer.ip}:${peer.port}`
}

function platformIcon(deviceType: string, alias: string): typeof Monitor {
  const type = deviceType?.toLowerCase() ?? ''
  if (type === 'mobile') return Smartphone
  if (type === 'web') return Globe
  if (type === 'server' || type === 'headless') return Server
  if (type === 'desktop') return Monitor
  if (/(iphone|ipad|android|redmi|xiaomi|huawei|honor|pixel|oppo|vivo|samsung|mi\s*\d)/i.test(alias)) {
    return Smartphone
  }
  return Monitor
}

function formatLastSync(value: string | null): string {
  if (!value) return '尚未同步'
  // value 来自 Rust local_now_string: "YYYY-MM-DD HH:MM:SS"
  const parts = value.split(' ')
  if (parts.length !== 2) return value
  const today = new Date()
  const [date, time] = parts
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return date === todayStr ? `今天 ${time.slice(0, 5)}` : `${date.slice(5)} ${time.slice(0, 5)}`
}

export default function SyncPeerDialog({ open, onClose, anchorRect }: Props) {
  const [localHello, setLocalHello] = useState<SyncHello | null>(null)
  const [peers, setPeers] = useState<SyncPeer[]>([])
  const [links, setLinks] = useState<LinkedDevice[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualUrl, setManualUrl] = useState(() => localStorage.getItem('sls.sync.peerUrl') ?? '')
  const [manualBusy, setManualBusy] = useState(false)
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingAlias, setEditingAlias] = useState(false)
  const [aliasDraft, setAliasDraft] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)

  const position = useMemo<CSSProperties>(() => {
    if (!anchorRect) return { top: 56, right: 16 }
    const right = Math.max(16, window.innerWidth - anchorRect.right)
    const top = anchorRect.bottom + 8
    return { top, right }
  }, [anchorRect])

  const refreshLinks = useCallback(async () => {
    try {
      const list = await fetchSyncLinks()
      setLinks(list)
    } catch (e) {
      console.error('[Sync] 拉取链接列表失败', e)
    }
  }, [])

  const refreshPeers = useCallback(async () => {
    setError(null)
    setMessage(null)
    setDiscovering(true)
    try {
      const next = await discoverSyncPeers()
      setPeers(next)
      const unlinked = next.filter((p) => !links.some((l) => l.device_id === p.device_id))
      setMessage(unlinked.length > 0 ? `当前可见 ${next.length} 台，${unlinked.length} 台未链接` : '附近的设备都已链接')
    } catch (e) {
      setError(`搜索失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDiscovering(false)
    }
  }, [links])

  useEffect(() => {
    if (!open) return
    fetchSyncHello().then(setLocalHello).catch(() => {})
    fetchSyncPeers().then(setPeers).catch(() => {})
    refreshLinks()
  }, [open, refreshLinks])

  // 别人 push 过来 / 自己 sync 完，sync:imported 事件会触发；这里只刷新链接状态
  useEffect(() => {
    if (!open) return
    let unlisten: (() => void) | undefined
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('sync:imported', () => {
        refreshLinks()
      }).then((fn) => { unlisten = fn }).catch(() => {})
    })
    return () => { unlisten?.() }
  }, [open, refreshLinks])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const node = dialogRef.current
      if (!node || node.contains(event.target as Node)) return
      if (anchorRect) {
        const { left, right, top, bottom } = anchorRect
        if (event.clientX >= left && event.clientX <= right && event.clientY >= top && event.clientY <= bottom) return
      }
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, onClose, anchorRect])

  const peerByDeviceId = useMemo(() => {
    const map = new Map<string, SyncPeer>()
    for (const p of peers) map.set(p.device_id, p)
    return map
  }, [peers])

  const unlinkedPeers = useMemo(() => {
    const linkedIds = new Set(links.map((l) => l.device_id))
    return peers.filter((p) => !linkedIds.has(p.device_id))
  }, [peers, links])

  const linkDevice = useCallback(async (peer: SyncPeer) => {
    setError(null)
    setMessage(null)
    setBusyLinkId(peer.device_id)
    try {
      const link = await addSyncLink(peer.device_id, peer.alias, peerBaseUrl(peer))
      setLinks((prev) => {
        const without = prev.filter((l) => l.device_id !== link.device_id)
        return [link, ...without]
      })
      setMessage(`已与 ${peer.alias} 建立链接，正在做第一次同步`)
    } catch (e) {
      setError(`建立链接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyLinkId(null)
    }
  }, [])

  const unlinkDevice = useCallback(async (link: LinkedDevice) => {
    setError(null)
    setMessage(null)
    setBusyLinkId(link.device_id)
    try {
      await removeSyncLink(link.device_id)
      setLinks((prev) => prev.filter((l) => l.device_id !== link.device_id))
      setMessage(`已解除与 ${link.alias} 的链接`)
    } catch (e) {
      setError(`解除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyLinkId(null)
    }
  }, [])

  const syncLinkNow = useCallback(async (link: LinkedDevice) => {
    setError(null)
    setMessage(null)
    setBusyLinkId(link.device_id)
    try {
      const result = await runSyncLink(link.device_id)
      const total = result.pulled.activity_categories + result.pulled.activity_tags
        + result.pulled.activity_blocks + result.pulled.plan_nodes + result.pulled.planned_blocks
        + result.pushed.activity_categories + result.pushed.activity_tags
        + result.pushed.activity_blocks + result.pushed.plan_nodes + result.pushed.planned_blocks
      setMessage(`与 ${link.alias} 同步完成 · ${total} 条变更`)
      refreshLinks()
    } catch (e) {
      setError(`同步失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyLinkId(null)
    }
  }, [refreshLinks])

  const connectAndLinkManual = useCallback(async () => {
    if (!manualUrl.trim()) {
      setError('请先输入对方电脑的 IP 或地址')
      return
    }
    setError(null)
    setMessage(null)
    setManualBusy(true)
    try {
      const hello = await fetchSyncHello(manualUrl)
      localStorage.setItem('sls.sync.peerUrl', manualUrl)
      const url = new URL(manualUrl.startsWith('http') ? manualUrl : `http://${manualUrl}`)
      const ip = url.hostname
      const port = Number(url.port || 49733)
      const lastBase = `http://${ip}:${port}`
      const link = await addSyncLink(hello.device_id, hello.alias || ip, lastBase)
      setLinks((prev) => {
        const without = prev.filter((l) => l.device_id !== link.device_id)
        return [link, ...without]
      })
      setMessage(`已与 ${link.alias} 建立链接`)
      setManualOpen(false)
    } catch (e) {
      setError(`连接失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setManualBusy(false)
    }
  }, [manualUrl])

  const startAliasEdit = useCallback(() => {
    setAliasDraft(localHello?.alias ?? '')
    setEditingAlias(true)
  }, [localHello])

  const confirmAliasEdit = useCallback(async () => {
    const next = aliasDraft.trim()
    if (!next) { setError('别名不能为空'); return }
    if (next === localHello?.alias) { setEditingAlias(false); return }
    setError(null)
    try {
      const saved = await setLocalSyncAlias(next)
      setLocalHello((prev) => prev ? { ...prev, alias: saved } : prev)
      setEditingAlias(false)
      setMessage(`已改名为 ${saved}`)
    } catch (e) {
      setError(`改名失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [aliasDraft, localHello])

  if (!open) return null

  const LocalIcon = platformIcon(localHello?.device_type ?? 'desktop', localHello?.alias ?? '')

  return (
    <div
      ref={dialogRef}
      style={{
        position: 'fixed',
        width: 460,
        maxHeight: 'calc(100vh - 80px)',
        background: theme.hudFillDeep,
        color: theme.textPrimary,
        fontFamily: theme.fontBody,
        boxShadow: `0 10px 28px rgba(0,0,0,0.55), 0 0 24px ${theme.electricBlue}26`,
        zIndex: 1200,
        padding: 16,
        overflow: 'auto',
        ...position,
      }}
    >
      <HudFrame
        topLabel="SYNC LINK · 局域网同步"
        showNotchTop
        notchWidth={150}
        notchDepth={8}
        cornerSize={16}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 6 }}>
        {/* 本机 + 操作 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{
            flex: 1,
            minWidth: 0,
            border: `1px solid ${theme.hudFrameSoft}`,
            background: 'rgba(0,229,255,0.04)',
            padding: '8px 10px',
            display: 'grid',
            gap: 4,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Wifi size={11} color={theme.electricBlue} />
              <span style={labelStyle}>本机</span>
              {localHello?.device_model && (
                <span style={modelBadgeStyle}>{localHello.device_model}</span>
              )}
              <span style={{
                marginLeft: 'auto',
                fontFamily: theme.fontMono,
                fontSize: 9,
                color: theme.expGreen,
                letterSpacing: 1.4,
              }}>
                ONLINE
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <div style={{
                width: 28,
                height: 28,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: `1px solid ${theme.electricBlue}66`,
                background: 'rgba(0,229,255,0.08)',
                color: theme.electricBlue,
              }}>
                <LocalIcon size={15} />
              </div>
              {editingAlias ? (
                <span style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                  <input
                    autoFocus
                    value={aliasDraft}
                    onChange={(e) => setAliasDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmAliasEdit()
                      else if (e.key === 'Escape') setEditingAlias(false)
                    }}
                    style={inputStyle}
                  />
                  <button onClick={confirmAliasEdit} title="保存" style={iconBtnTiny(theme.expGreen)}>
                    <Check size={11} />
                  </button>
                  <button onClick={() => setEditingAlias(false)} title="取消" style={iconBtnTiny(theme.textSecondary)}>
                    <X size={11} />
                  </button>
                </span>
              ) : (
                <>
                  <span style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 700,
                    color: theme.textPrimary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {localHello?.alias ?? '读取中…'}
                  </span>
                  <button onClick={startAliasEdit} title="改名" style={iconBtnTiny(theme.textMuted)}>
                    <Pencil size={11} />
                  </button>
                </>
              )}
            </div>
            <div style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted }}>
              指纹 {localHello?.pair_code ?? '----'}
            </div>
          </div>
          <Tooltip content="重新搜索附近设备">
            <button type="button" onClick={refreshPeers} disabled={discovering} style={iconButtonStyle(theme.electricBlue, discovering)}>
              <RefreshCw size={14} className={discovering ? 'spin' : undefined} />
            </button>
          </Tooltip>
          <Tooltip content="关闭">
            <button type="button" onClick={onClose} style={iconButtonStyle(theme.textSecondary, false)}>
              <X size={14} />
            </button>
          </Tooltip>
        </div>

        {/* 已链接 */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Link2 size={12} color={theme.expGreen} />
            <span style={{ ...sectionTitleStyle, color: theme.expGreen }}>LINKED</span>
            <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted }}>
              · {links.length} 台 · 启动即自动同步
            </span>
          </div>
          {links.length === 0 ? (
            <div style={{
              border: `1px dashed ${theme.expGreen}44`,
              padding: '12px 11px',
              fontSize: 11.5,
              lineHeight: 1.6,
              color: theme.textMuted,
            }}>
              还没有已链接的设备。下方"附近未链接"区点 <Link2 size={11} style={{ verticalAlign: 'middle', color: theme.expGreen }} /> 建立链接，之后两台设备一打开就互相同步。
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {links.map((link) => {
                const peer = peerByDeviceId.get(link.device_id)
                const online = !!peer
                const Icon = platformIcon(peer?.device_type ?? 'desktop', link.alias)
                const busy = busyLinkId === link.device_id
                return (
                  <LinkedCard
                    key={link.device_id}
                    link={link}
                    online={online}
                    busy={busy}
                    deviceModel={peer?.device_model}
                    Icon={Icon}
                    onSyncNow={() => syncLinkNow(link)}
                    onUnlink={() => unlinkDevice(link)}
                  />
                )
              })}
            </div>
          )}
        </div>

        {/* 附近未链接 */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Wifi size={12} color={theme.electricBlue} />
            <span style={sectionTitleStyle}>NEARBY</span>
            <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted }}>
              · {unlinkedPeers.length} 台未链接
            </span>
          </div>
          {unlinkedPeers.length === 0 ? (
            <div style={{
              border: `1px dashed ${theme.hudFrameSoft}`,
              padding: '10px 11px',
              fontSize: 11.5,
              color: theme.textMuted,
            }}>
              {discovering ? '正在搜索…' : '附近没有新的可链接设备'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
              {unlinkedPeers.map((peer) => (
                <UnlinkedCard
                  key={peer.device_id}
                  peer={peer}
                  busy={busyLinkId === peer.device_id}
                  onLink={() => linkDevice(peer)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 折叠：手动输入 IP（直接建立链接） */}
        <div style={{
          border: `1px solid ${manualOpen ? theme.hudFrameSoft : theme.glassBorder}`,
          background: manualOpen ? 'rgba(0,229,255,0.04)' : 'transparent',
        }}>
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 10px', border: 'none', background: 'transparent',
              color: theme.textSecondary, cursor: 'pointer',
              fontSize: 11.5, fontFamily: theme.fontBody, textAlign: 'left',
            }}
          >
            <ChevronRight size={13} style={{
              color: theme.electricBlue,
              transform: manualOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
            }} />
            <Plug size={12} color={theme.electricBlue} />
            <span>找不到设备？手动输入 IP 建立链接</span>
          </button>
          {manualOpen && (
            <div style={{ padding: '0 10px 10px', display: 'flex', gap: 6 }}>
              <input
                value={manualUrl}
                onChange={(e) => setManualUrl(e.target.value)}
                placeholder="例：192.168.1.10 或 192.168.1.10:49733"
                style={inputStyle}
                onKeyDown={(e) => { if (e.key === 'Enter' && !manualBusy) connectAndLinkManual() }}
              />
              <button
                type="button"
                onClick={connectAndLinkManual}
                disabled={manualBusy}
                style={{
                  ...primaryButtonStyle(theme.electricBlue),
                  opacity: manualBusy ? 0.5 : 1,
                  cursor: manualBusy ? 'wait' : 'pointer',
                }}
              >
                {manualBusy ? '连接中…' : '建立链接'}
              </button>
            </div>
          )}
        </div>

        {(message || error) && (
          <div style={{
            border: `1px solid ${error ? 'rgba(255,80,80,0.35)' : 'rgba(70,255,170,0.28)'}`,
            background: error ? 'rgba(255,80,80,0.06)' : 'rgba(70,255,170,0.05)',
            color: error ? '#ff9b9b' : theme.expGreen,
            padding: '7px 10px',
            fontSize: 11.5,
            lineHeight: 1.45,
          }}>
            {error ?? message}
          </div>
        )}
      </div>

      <style>{`
        .spin { animation: solo-spin 1s linear infinite; }
        @keyframes solo-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

function LinkedCard({
  link, online, busy, deviceModel, Icon, onSyncNow, onUnlink,
}: {
  link: LinkedDevice
  online: boolean
  busy: boolean
  deviceModel?: string
  Icon: typeof Monitor
  onSyncNow: () => void
  onUnlink: () => void
}) {
  const tint = online ? theme.expGreen : theme.textMuted
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'auto 1fr auto',
      alignItems: 'center',
      gap: 10,
      padding: '8px 10px',
      border: `1px solid ${tint}44`,
      background: online ? 'rgba(70,255,170,0.04)' : 'rgba(255,255,255,0.02)',
      position: 'relative',
    }}>
      {/* 链接线视觉：左侧一段绿色发光竖条 */}
      <div style={{
        position: 'absolute',
        left: -1, top: 8, bottom: 8, width: 3,
        background: tint,
        boxShadow: online ? `0 0 8px ${theme.expGreen}AA` : undefined,
        opacity: online ? 1 : 0.45,
      }} />
      <div style={{
        width: 32, height: 32,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${tint}66`,
        background: online ? `${theme.expGreen}10` : 'rgba(255,255,255,0.025)',
        color: online ? theme.expGreen : theme.textSecondary,
        position: 'relative',
      }}>
        <Icon size={16} />
        <span style={{
          position: 'absolute',
          right: -2, top: -2,
          width: 8, height: 8, borderRadius: '50%',
          background: online ? theme.expGreen : theme.textMuted,
          boxShadow: online ? `0 0 6px ${theme.expGreen}` : undefined,
        }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{
            flex: 1, minWidth: 0,
            fontSize: 12.5, fontWeight: 700, color: theme.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {link.alias}
          </span>
          {deviceModel && <span style={modelBadgeStyle}>{deviceModel}</span>}
        </div>
        <div style={{
          fontFamily: theme.fontMono, fontSize: 10, color: theme.textMuted, marginTop: 2,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Link2 size={9} color={online ? theme.expGreen : theme.textMuted} />
          <span>{online ? '在线 · 自动同步中' : '离线 · 等下次见面'}</span>
          <span style={{ opacity: 0.7 }}>· {formatLastSync(link.last_synced_at)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <Tooltip content="立即同步一次">
          <button
            type="button"
            onClick={onSyncNow}
            disabled={!online || busy}
            style={iconButtonStyle(theme.expGreen, !online || busy)}
          >
            <RotateCw size={12} className={busy ? 'spin' : undefined} />
          </button>
        </Tooltip>
        <Tooltip content="解除链接">
          <button
            type="button"
            onClick={onUnlink}
            disabled={busy}
            style={iconButtonStyle(theme.dangerRed, busy)}
          >
            <Link2Off size={12} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function UnlinkedCard({
  peer, busy, onLink,
}: {
  peer: SyncPeer
  busy: boolean
  onLink: () => void
}) {
  const Icon = platformIcon(peer.device_type, peer.alias)
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '8px 10px',
      border: `1px solid ${theme.hudFrameSoft}`,
      background: 'rgba(0,229,255,0.03)',
    }}>
      <div style={{
        width: 28, height: 28, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: `1px solid ${theme.hudFrameSoft}`,
        background: 'rgba(0,229,255,0.06)',
        color: theme.textPrimary,
      }}>
        <Icon size={14} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
          <span style={{
            flex: 1, minWidth: 0,
            fontSize: 12, fontWeight: 700, color: theme.textPrimary,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {peer.alias}
          </span>
          {peer.device_model && <span style={modelBadgeStyle}>{peer.device_model}</span>}
        </div>
        <div style={{
          fontFamily: theme.fontMono, fontSize: 9.5, color: theme.textMuted,
          marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {peer.ip}{peer.source === 'manual' ? '' : ` · ${peer.source}`}
        </div>
      </div>
      <Tooltip content="建立链接（之后双向自动同步）">
        <button
          type="button"
          onClick={onLink}
          disabled={busy}
          style={{
            ...primaryButtonStyle(theme.expGreen),
            opacity: busy ? 0.5 : 1,
            cursor: busy ? 'wait' : 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Link2 size={11} className={busy ? 'spin' : undefined} />
          链接
        </button>
      </Tooltip>
    </div>
  )
}

// ── 样式 ──

const labelStyle: CSSProperties = {
  fontFamily: theme.fontMono,
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 1.6,
  color: theme.textSecondary,
}

const sectionTitleStyle: CSSProperties = {
  fontFamily: theme.fontMono,
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: 2,
  color: theme.electricBlue,
}

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'rgba(0,0,0,0.4)',
  border: `1px solid ${theme.glassBorder}`,
  color: theme.textPrimary,
  padding: '5px 8px',
  fontSize: 11.5,
  fontFamily: theme.fontMono,
  outline: 'none',
}

function iconButtonStyle(color: string, disabled: boolean): CSSProperties {
  return {
    width: 26,
    height: 26,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: `1px solid ${theme.hudFrameSoft}`,
    background: 'rgba(0,229,255,0.04)',
    color,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  }
}

function primaryButtonStyle(color: string): CSSProperties {
  return {
    height: 26,
    padding: '0 10px',
    border: `1px solid ${color}66`,
    background: `${color}14`,
    color,
    fontFamily: theme.fontMono,
    fontSize: 11,
    letterSpacing: 0.6,
    cursor: 'pointer',
  }
}

const modelBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px',
  fontFamily: theme.fontMono,
  fontSize: 9,
  letterSpacing: 0.6,
  color: theme.textSecondary,
  background: 'rgba(255,255,255,0.04)',
  border: `1px solid ${theme.glassBorder}`,
  whiteSpace: 'nowrap',
  flexShrink: 0,
}

function iconBtnTiny(color: string): CSSProperties {
  return {
    width: 20,
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    padding: 0,
  }
}
