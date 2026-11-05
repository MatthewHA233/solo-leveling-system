// ══════════════════════════════════════════════
// 局域网配对：本机身份、附近设备、手动输入、已链接设备、同步日志
// 同步本身由原生 SyncRuntime 自动完成，这里只负责建立和管理链接
// ══════════════════════════════════════════════

import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  linkPeer,
  listLinkedDevices,
  probeLinkedPeers,
  syncNow,
  unlinkPeer,
  type ImportResult,
  type LinkedDevice,
  type LinkProbe,
} from '../../lib/syncclient'
import {
  createPairCode,
  getSyncLog,
  getSyncServerStatus,
  listNearbyPeers,
  refreshNearbyPeers,
  retrySyncServer,
  setSyncAlias,
  subscribeSyncStatus,
  type NearbyPeer,
  type SyncLogEntry,
  type SyncServerStatus,
} from '../../lib/syncserver'
import { theme } from '../../theme'

const NEARBY_POLL_MS = 3000
const LINK_PROBE_MS = 5000

function summarize(r: ImportResult): string {
  const parts: string[] = []
  const blocks = r.activityBlocks + r.plannedBlocks + r.planNodes
  if (blocks > 0) parts.push(`时间块 ${blocks}`)
  if (r.activityCategories + r.activityTags > 0) parts.push(`标签 ${r.activityCategories + r.activityTags}`)
  if (r.chatSessions + r.chatMessages > 0) parts.push(`聊天 ${r.chatMessages}`)
  if (r.modelApiKeys + r.modelCallLog + r.featureBindings > 0) {
    parts.push(`模型数据 ${r.modelApiKeys + r.modelCallLog + r.featureBindings}`)
  }
  if (r.settings > 0) parts.push(`设置 ${r.settings}`)
  if (r.chatImages > 0) parts.push(`聊天图片 ${r.chatImages}`)
  return parts.length > 0 ? parts.join(' · ') : '无变化'
}

export default function PairingCard() {
  const [status, setStatus] = useState<SyncServerStatus | null>(null)
  const [nearby, setNearby] = useState<NearbyPeer[]>([])
  const [links, setLinks] = useState<LinkedDevice[]>([])
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  // 本机的配对码：主人点了才生成，给对方设备输入
  const [pairCode, setPairCode] = useState<{ code: string; expiresAt: number } | null>(null)
  // 正在和哪台设备配对：要输入它屏幕上的配对码
  const [pairTarget, setPairTarget] = useState<{ key: string; label: string; base: string } | null>(null)
  const [codeInput, setCodeInput] = useState('')
  const linksRef = useRef<LinkedDevice[]>([])
  const [probes, setProbes] = useState<readonly LinkProbe[]>([])
  const [refreshing, setRefreshing] = useState(false)
  // 正在改别名时是输入框的内容
  const [aliasDraft, setAliasDraft] = useState<string | null>(null)
  const [log, setLog] = useState<readonly SyncLogEntry[]>([])
  const [logOpen, setLogOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const refreshLinks = useCallback(async () => {
    try {
      const next = await listLinkedDevices()
      const prev = linksRef.current
      // 多了一台，或者已链接的设备换了令牌（重新配对）：本机的配对码刚被用掉
      const paired = next.length > prev.length
        || next.some((n) => prev.some((p) => p.deviceId === n.deviceId && p.authToken !== n.authToken))
      if (paired) setPairCode(null)
      linksRef.current = next
      setLinks(next)
    } catch {
      setLinks([])
    }
  }, [])

  const refreshLog = useCallback(() => {
    getSyncLog().then(setLog).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    const tick = () => {
      getSyncServerStatus().then((s) => { if (alive) setStatus(s) }).catch(() => {})
      listNearbyPeers().then((p) => { if (alive) setNearby(p) }).catch(() => {})
    }
    tick()
    void refreshLinks()
    refreshLog()
    const timer = setInterval(tick, NEARBY_POLL_MS)
    const unsubscribe = subscribeSyncStatus(() => {
      void refreshLinks()
      refreshLog()
    })
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [refreshLinks, refreshLog])

  // 已链接设备的在线状态和型号。只在有已链接设备时才问
  const hasLinks = links.length > 0
  useEffect(() => {
    if (!hasLinks) return
    let alive = true
    const probe = () => {
      probeLinkedPeers().then((p) => { if (alive) setProbes(p) }).catch(() => {})
    }
    probe()
    const timer = setInterval(probe, LINK_PROBE_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [hasLinks])

  // 倒计时每秒走一次
  useEffect(() => {
    if (!hasLinks) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasLinks])

  useEffect(() => {
    if (!pairCode) return
    const timer = setTimeout(() => setPairCode(null), pairCode.expiresAt - Date.now())
    return () => clearTimeout(timer)
  }, [pairCode])

  const generatePairCode = useCallback(async () => {
    try {
      const r = await createPairCode()
      if (r) setPairCode({ code: r.code, expiresAt: Date.now() + r.ttlSeconds * 1000 })
    } catch (e: any) {
      setMessage(`生成配对码失败：${e?.message ?? String(e)}`)
    }
  }, [])

  const refreshPeers = useCallback(async () => {
    setRefreshing(true)
    try {
      setNearby(await refreshNearbyPeers())
    } catch (e: any) {
      setMessage(`刷新失败：${e?.message ?? String(e)}`)
    } finally {
      setRefreshing(false)
    }
  }, [])

  const confirmAlias = useCallback(async () => {
    if (aliasDraft == null) return
    try {
      const next = await setSyncAlias(aliasDraft)
      if (next) setStatus(next)
      setAliasDraft(null)
    } catch (e: any) {
      setMessage(`改名失败：${e?.message ?? String(e)}`)
    }
  }, [aliasDraft])

  const startPairing = useCallback((key: string, label: string, base: string) => {
    setPairTarget({ key, label, base })
    setCodeInput('')
    setMessage('')
  }, [])

  const confirmPairing = useCallback(async () => {
    if (!pairTarget) return
    setBusy(pairTarget.key)
    setMessage('')
    try {
      const r = await linkPeer(pairTarget.base, codeInput.trim())
      if (r) {
        setMessage(r.pulled && r.pushed
          ? `已链接 ${r.alias}：拉取 ${summarize(r.pulled)}；推送 ${summarize(r.pushed)}`
          : `已链接 ${r.alias}，第一次同步没成功（${r.syncError ?? '原因未知'}），之后会自动重试`)
        setAddress('')
        setPairTarget(null)
      }
    } catch (e: any) {
      setMessage(`配对失败：${e?.message ?? String(e)}`)
    } finally {
      setBusy(null)
      void refreshLinks()
    }
  }, [pairTarget, codeInput, refreshLinks])

  const runSync = useCallback(async (device: LinkedDevice) => {
    setBusy(device.deviceId)
    setMessage('')
    try {
      const r = await syncNow(device.deviceId)
      if (r) setMessage(`${device.alias}：拉取 ${summarize(r.pulled)}；推送 ${summarize(r.pushed)}`)
    } catch (e: any) {
      setMessage(`同步失败：${e?.message ?? String(e)}`)
    } finally {
      setBusy(null)
      void refreshLinks()
    }
  }, [refreshLinks])

  const unlink = useCallback(async (device: LinkedDevice) => {
    try {
      await unlinkPeer(device.deviceId)
      setMessage(`已解除与 ${device.alias} 的链接`)
    } catch (e: any) {
      setMessage(`解除失败：${e?.message ?? String(e)}`)
    } finally {
      void refreshLinks()
    }
  }, [refreshLinks])

  const linkedIds = new Set(links.map((d) => d.deviceId))
  const unlinkedNearby = nearby.filter((p) => !linkedIds.has(p.deviceId))
  const anySyncing = links.some((d) => d.syncing)
  const nextSyncIn = status?.nextAutoSyncAt
    ? Math.max(0, Math.ceil((status.nextAutoSyncAt - now) / 1000))
    : null

  return (
    <View style={styles.card}>
      <Text style={styles.title}>局域网配对</Text>
      <Text style={styles.sub}>配对后自动同步，不用打开这个页面。</Text>

      {status?.running ? (
        <View style={styles.identity}>
          {aliasDraft != null ? (
            <View style={styles.inputRow}>
              <TextInput
                value={aliasDraft}
                onChangeText={setAliasDraft}
                placeholder="这台设备的名字"
                placeholderTextColor={theme.inkSoft}
                maxLength={32}
                autoFocus
                style={styles.input}
              />
              <Pressable
                style={styles.btn}
                disabled={aliasDraft.trim().length === 0}
                onPress={() => void confirmAlias()}
              >
                <Text style={styles.btnText}>确定</Text>
              </Pressable>
              <Pressable style={styles.plainBtn} hitSlop={8} onPress={() => setAliasDraft(null)}>
                <Text style={styles.link}>取消</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.headRow}>
              <Text style={styles.alias} numberOfLines={1}>{status.alias}</Text>
              <Pressable hitSlop={8} onPress={() => setAliasDraft(status.alias)}>
                <Text style={styles.link}>改名</Text>
              </Pressable>
            </View>
          )}
          <Text style={styles.sub}>{status.deviceModel} · 指纹 {status.pairCode}</Text>
          {status.ipv4s.length > 0 ? (
            status.ipv4s.map((ip) => (
              <Text key={ip} selectable style={styles.address}>{ip}:{status.port}</Text>
            ))
          ) : (
            <Text style={styles.warn}>没有局域网地址，检查一下 Wi-Fi</Text>
          )}
          {pairCode ? (
            <View style={styles.codeBox}>
              <Text selectable style={styles.code}>{pairCode.code}</Text>
              <Text style={styles.sub}>在另一台设备上输入这个配对码，5 分钟内有效。只需配对一次。</Text>
            </View>
          ) : (
            <Pressable style={styles.ghostBtn} onPress={() => void generatePairCode()}>
              <Text style={styles.ghostBtnText}>生成配对码</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View style={styles.identity}>
          <Text style={styles.warn}>{status?.error ?? '同步服务未启动'}</Text>
          <Pressable
            style={styles.ghostBtn}
            onPress={() => { retrySyncServer().then(setStatus).catch(() => {}) }}
          >
            <Text style={styles.ghostBtnText}>重试</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>附近设备</Text>
        <Pressable hitSlop={8} disabled={refreshing} onPress={() => void refreshPeers()}>
          <Text style={styles.link}>{refreshing ? '查找中…' : '刷新'}</Text>
        </Pressable>
      </View>
      {unlinkedNearby.length === 0 ? (
        <Text style={styles.sub}>
          {nearby.length > 0 ? '附近的设备都已链接。' : '还没发现设备。电脑端打开后，这里会自动出现。'}
        </Text>
      ) : (
        unlinkedNearby.map((peer) => (
          <View key={peer.deviceId} style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>{peer.alias}</Text>
              <Text style={styles.sub} numberOfLines={1}>{peer.deviceModel} · 指纹 {peer.pairCode}</Text>
            </View>
            <Pressable
              style={styles.btn}
              disabled={busy != null}
              onPress={() => startPairing(peer.deviceId, peer.alias, peer.base)}
            >
              <Text style={styles.btnText}>配对</Text>
            </Pressable>
          </View>
        ))
      )}

      <Text style={styles.section}>手动输入地址</Text>
      <View style={styles.inputRow}>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="192.168.0.104"
          placeholderTextColor={theme.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          editable={busy == null}
          style={styles.input}
        />
        <Pressable
          style={styles.btn}
          disabled={busy != null || address.trim().length === 0}
          onPress={() => startPairing('manual', address.trim(), address.trim())}
        >
          <Text style={styles.btnText}>配对</Text>
        </Pressable>
      </View>

      {pairTarget && (
        <View style={styles.pairBox}>
          <Text style={styles.sub}>在「{pairTarget.label}」上生成配对码，输入到这里。只需要配对这一次。</Text>
          <View style={styles.inputRow}>
            <TextInput
              value={codeInput}
              onChangeText={setCodeInput}
              placeholder="6 位配对码"
              placeholderTextColor={theme.inkSoft}
              keyboardType="number-pad"
              maxLength={6}
              editable={busy == null}
              style={styles.input}
            />
            <Pressable
              style={styles.btn}
              disabled={busy != null || codeInput.trim().length === 0}
              onPress={() => void confirmPairing()}
            >
              <Text style={styles.btnText}>{busy != null ? '配对中…' : '确定'}</Text>
            </Pressable>
          </View>
          <Pressable style={styles.ghostBtn} disabled={busy != null} onPress={() => setPairTarget(null)}>
            <Text style={styles.ghostBtnText}>取消</Text>
          </Pressable>
        </View>
      )}

      <Text style={styles.section}>已链接</Text>
      {links.length === 0 ? (
        <Text style={styles.sub}>还没有链接任何设备。</Text>
      ) : nextSyncIn != null && (
        <Text style={styles.sub}>
          {anySyncing ? '正在同步…' : `${nextSyncIn} 秒后自动同步附近的设备`}
        </Text>
      )}
      {links.map((device) => {
        const peer = nearby.find((p) => p.deviceId === device.deviceId)
        const probe = probes.find((p) => p.deviceId === device.deviceId)
        const online = !!peer || !!probe?.online
        const model = probe?.deviceModel || peer?.deviceModel
        return (
          <View key={device.deviceId} style={styles.linkBox}>
            <View style={styles.headRow}>
              <View style={[styles.dot, online && styles.dotOnline]} />
              <Text style={styles.rowTitle} numberOfLines={1}>{device.alias}</Text>
            </View>
            <Text style={styles.sub} numberOfLines={1}>
              {[online ? '在线' : '离线', model, device.lastBase].filter(Boolean).join(' · ')}
            </Text>
            <Text style={styles.sub}>
              {device.syncing ? '同步中…' : `上次同步：${device.lastSyncedAt ?? '尚未同步'}`}
            </Text>
            {!!device.lastError && <Text style={styles.warn} numberOfLines={2}>{device.lastError}</Text>}
            <View style={styles.actions}>
              <Pressable
                style={styles.btn}
                disabled={busy != null || device.syncing}
                onPress={() => void runSync(device)}
              >
                <Text style={styles.btnText}>{busy === device.deviceId ? '同步中…' : '立即同步'}</Text>
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={() => void unlink(device)}>
                <Text style={styles.ghostBtnText}>解除</Text>
              </Pressable>
            </View>
          </View>
        )
      })}

      {!!message && <Text style={styles.message} numberOfLines={4}>{message}</Text>}

      <View style={styles.sectionRow}>
        <Text style={styles.sectionTitle}>同步日志 · 最近 {log.length} 条</Text>
        <Pressable hitSlop={8} onPress={() => setLogOpen((v) => !v)}>
          <Text style={styles.link}>{logOpen ? '收起' : '展开'}</Text>
        </Pressable>
      </View>
      {logOpen && (log.length === 0 ? (
        <Text style={styles.sub}>还没有日志记录。</Text>
      ) : (
        log.map((entry, i) => (
          <Text key={`${entry.at}-${i}`} style={styles.logLine}>
            {new Date(entry.at).toTimeString().slice(0, 8)}  {entry.text}
          </Text>
        ))
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: theme.line,
  },
  title: { fontSize: 15, fontWeight: '700', color: theme.ink },
  sub: { fontSize: 12, color: theme.inkSoft, marginTop: 3 },
  identity: { marginTop: 12 },
  alias: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: theme.ink },
  address: { fontSize: 18, fontWeight: '600', color: theme.ink, marginTop: 6 },
  warn: { fontSize: 12, color: theme.danger, marginTop: 4 },
  section: { fontSize: 12, fontWeight: '600', color: theme.ink, marginTop: 16, marginBottom: 2 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    marginBottom: 2,
  },
  sectionTitle: { fontSize: 12, fontWeight: '600', color: theme.ink },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  link: { fontSize: 12, fontWeight: '600', color: theme.accent },
  plainBtn: { paddingHorizontal: 2 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.line },
  dotOnline: { backgroundColor: theme.accent },
  logLine: { fontSize: 11, lineHeight: 16, color: theme.inkSoft, marginTop: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.line,
    marginTop: 6,
  },
  rowMain: { flex: 1 },
  rowTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600', color: theme.ink },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: theme.ink,
    backgroundColor: theme.bg,
  },
  linkBox: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: {
    backgroundColor: theme.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  ghostBtn: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: theme.line,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    marginTop: 4,
  },
  ghostBtnText: { color: theme.ink, fontSize: 13, fontWeight: '600' },
  message: { fontSize: 12, color: theme.inkSoft, marginTop: 12 },
  codeBox: { marginTop: 10 },
  code: { fontSize: 26, fontWeight: '700', color: theme.ink, letterSpacing: 4 },
  pairBox: {
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
})
