// RN Hermes 没有 crypto.randomUUID — v4 uuid 的轻量替代
// （仅用于消息/工具调用的本地标识，无安全性要求）
export function randomUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
