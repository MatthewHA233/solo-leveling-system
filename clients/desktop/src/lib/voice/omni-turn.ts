// ══════════════════════════════════════════════
// Omni 实时语音：等回复的看门狗（手机端 lib/voice/omni-turn.ts 同一份）
// 录音提交后服务端可能一个字都不回、连接也可能无声无息地断了，
// 这时没有任何事件能让 Fairy 从「思考中」回来，只能靠超时。
// ══════════════════════════════════════════════

/** 一轮回复里这么久没有任何新内容，算没有回应 */
export const OMNI_REPLY_TIMEOUT_MS = 30_000
/** 排队的音频播完后，最多再等这么久 */
export const OMNI_PLAYBACK_GRACE_MS = 5_000

export interface OmniWatchdog {
  /** 开始等（提交录音、工具开始或跑完），重新计时 */
  readonly arm: () => void
  /** 收到新内容：正在等就重新计时，没在等不起作用 */
  readonly touch: () => void
  /** 这一轮结束 */
  readonly disarm: () => void
  /** 是否有一轮回复正在进行 */
  readonly isArmed: () => boolean
}

/** isBusy：工具还在跑时不算超时（工具可能比回复慢得多） */
export function createOmniWatchdog(
  timeoutMs: number,
  isBusy: () => boolean,
  onTimeout: () => void,
): OmniWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null

  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const arm = () => {
    disarm()
    timer = setTimeout(() => {
      timer = null
      if (isBusy()) arm()
      else onTimeout()
    }, timeoutMs)
  }

  return {
    arm,
    touch: () => { if (timer) arm() },
    disarm,
    isArmed: () => timer !== null,
  }
}
