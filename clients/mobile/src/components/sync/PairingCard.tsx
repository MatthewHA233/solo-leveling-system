// ══════════════════════════════════════════════
// 局域网配对：本机身份、附近设备、手动输入、已链接设备
// 同步本身由原生 SyncRuntime 自动完成，这里只负责建立和管理链接
// ══════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import {
  linkPeer,
  listLinkedDevices,
  syncNow,
  unlinkPeer,
  type ImportResult,
  type LinkedDevice,
} from '../../lib/syncclient'
import {
  getSyncServerStatus,
  listNearbyPeers,
  retrySyncServer,
  subscribeSyncStatus,
  type NearbyPeer,
  type SyncServerStatus,
} from '../../lib/syncserver'
import { theme } from '../../theme'

const NEARBY_POLL_MS = 3000

function summarize(r: ImportResult): string {
  const parts: string[] = []
  const blocks = r.activityBlocks + r.plannedBlocks + r.planNodes
  if (blocks > 0) parts.push(`时间块 ${blocks}`)
  if (r.activityCategories + r.activityTags > 0) parts.push(`标签 ${r.activityCategories + r.activityTags}`)
  if (r.chatSessions + r.chatMessages > 0) parts.push(`聊天 ${r.chatMessages}`)
  if (r.modelApiKeys + r.modelCallLog + r.featureBindings > 0) {
    parts.push(`模型数据 ${r.modelApiKeys + r.modelCallLog + r.featureBindings}`)
  }
  return parts.length > 0 ? parts.join(' · ') : '无变化'
}

export default function PairingCard() {
  const [status, setStatus] = useState<SyncServerStatus | null>(null)
  const [nearby, setNearby] = useState<NearbyPeer[]>([])
  const [links, setLinks] = useState<LinkedDevice[]>([])
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const refreshLinks = useCallback(async () => {
    try {
      setLinks(await listLinkedDevices())
    } catch {
      setLinks([])
    }
  }, [])

  useEffect(() => {
    let alive = true
    const tick = () => {
      getSyncServerStatus().then((s) => { if (alive) setStatus(s) }).catch(() => {})
      listNearbyPeers().then((p) => { if (alive) setNearby(p) }).catch(() => {})
    }
    tick()
    void refreshLinks()
    const timer = setInterval(tick, NEARBY_POLL_MS)
    const unsubscribe = subscribeSyncStatus(() => { void refreshLinks() })
    return () => {
      alive = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [refreshLinks])

  const link = useCallback(async (key: string, target: string) => {
    setBusy(key)
    setMessage('')
    try {
      const r = await linkPeer(target)
      if (r) {
        setMessage(`已链接 ${r.alias}：拉取 ${summarize(r.pulled)}；推送 ${summarize(r.pushed)}`)
        setAddress('')
      }
    } catch (e: any) {
      setMessage(`链接失败：${e?.message ?? String(e)}`)
    } finally {
      setBusy(null)
      void refreshLinks()
    }
  }, [refreshLinks])

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

  return (
    <View style={styles.card}>
      <Text style={styles.title}>局域网配对</Text>
      <Text style={styles.sub}>配对后自动同步，不用打开这个页面。</Text>

      {status?.running ? (
        <View style={styles.identity}>
          <Text style={styles.alias}>{status.alias}</Text>
          <Text style={styles.sub}>配对码 {status.pairCode}</Text>
          {status.ipv4s.length > 0 ? (
            status.ipv4s.map((ip) => (
              <Text key={ip} selectable style={styles.address}>{ip}:{status.port}</Text>
            ))
          ) : (
            <Text style={styles.warn}>没有局域网地址，检查一下 Wi-Fi</Text>
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

      <Text style={styles.section}>附近设备</Text>
      {unlinkedNearby.length === 0 ? (
        <Text style={styles.sub}>
          {nearby.length > 0 ? '附近的设备都已链接。' : '还没发现设备。电脑端打开后，这里会自动出现。'}
        </Text>
      ) : (
        unlinkedNearby.map((peer) => (
          <View key={peer.deviceId} style={styles.row}>
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} numberOfLines={1}>{peer.alias}</Text>
              <Text style={styles.sub} numberOfLines={1}>{peer.deviceModel} · 配对码 {peer.pairCode}</Text>
            </View>
            <Pressable
              style={styles.btn}
              disabled={busy != null}
              onPress={() => void link(peer.deviceId, peer.base)}
            >
              <Text style={styles.btnText}>{busy === peer.deviceId ? '链接中…' : '链接'}</Text>
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
          onPress={() => void link('manual', address.trim())}
        >
          <Text style={styles.btnText}>{busy === 'manual' ? '链接中…' : '链接'}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>已链接</Text>
      {links.length === 0 ? (
        <Text style={styles.sub}>还没有链接任何设备。</Text>
      ) : (
        links.map((device) => (
          <View key={device.deviceId} style={styles.linkBox}>
            <Text style={styles.rowTitle} numberOfLines={1}>{device.alias}</Text>
            <Text style={styles.sub} numberOfLines={1}>{device.lastBase}</Text>
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
        ))
      )}

      {!!message && <Text style={styles.message} numberOfLines={4}>{message}</Text>}
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
  alias: { fontSize: 14, fontWeight: '600', color: theme.ink },
  address: { fontSize: 18, fontWeight: '600', color: theme.ink, marginTop: 6 },
  warn: { fontSize: 12, color: theme.danger, marginTop: 4 },
  section: { fontSize: 12, fontWeight: '600', color: theme.ink, marginTop: 16, marginBottom: 2 },
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
  rowTitle: { fontSize: 14, fontWeight: '600', color: theme.ink },
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
})
