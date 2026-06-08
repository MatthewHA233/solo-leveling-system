import { solevupGetPref, solevupSetPref } from '../../lib/solevupdb'

export type TorrentReadMode = 'auto' | 'formal' | 'raw'

export const TORRENT_READ_MODE_PREF_KEY = 'torrent.readMode.v1'

export function normalizeTorrentReadMode(value: unknown): TorrentReadMode {
  return value === 'auto' || value === 'raw' || value === 'formal' ? value : 'formal'
}

export async function getTorrentReadMode(): Promise<TorrentReadMode> {
  const raw = await solevupGetPref(TORRENT_READ_MODE_PREF_KEY, 'formal')
  return normalizeTorrentReadMode(raw)
}

export async function setTorrentReadMode(mode: TorrentReadMode): Promise<void> {
  await solevupSetPref(TORRENT_READ_MODE_PREF_KEY, mode)
}
