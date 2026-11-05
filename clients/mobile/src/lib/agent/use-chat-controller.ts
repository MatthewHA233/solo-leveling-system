// React 订阅 ChatController 的 hook
import { useSyncExternalStore } from 'react'
import { chatController } from './chat-controller'

/** 控制器有任何变化都重渲染（聊天面板用） */
export function useChatController() {
  useSyncExternalStore(chatController.subscribe, chatController.getVersion)
  return chatController
}

/**
 * 只订阅其中一个值（对应 desktop 的 memo(Stage*)）：
 * 回复每流出一段字控制器都会变，App 这一层不能跟着把整个页面重算一遍。
 * selector 要返回原始值或稳定的引用。
 */
export function useChatSelector<T>(selector: (controller: typeof chatController) => T): T {
  return useSyncExternalStore(chatController.subscribe, () => selector(chatController))
}
