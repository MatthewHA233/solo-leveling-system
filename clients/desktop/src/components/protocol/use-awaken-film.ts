// 协议志 · 觉醒片：本机有没有这部片子（它含个人隐私、不进仓库，没有时入口不出现）

import { useEffect, useState } from 'react'

export const FILM_DIR = '/films/awaken/'

/** 本机有没有觉醒片（拿它的时间轴探一下） */
export function useAwakenFilmAvailable(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(`${FILM_DIR}timeline.json`, { cache: 'no-store' })
      .then((r) => { if (alive) setOk(r.ok && (r.headers.get('content-type') ?? '').includes('json')) })
      .catch(() => { /* 没有就不显示入口 */ })
    return () => { alive = false }
  }, [])
  return ok
}
