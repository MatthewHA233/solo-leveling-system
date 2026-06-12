// React 订阅 ChatController 的 hook
import { useEffect, useReducer } from 'react'
import { chatController } from './chat-controller'

export function useChatController() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => chatController.subscribe(force), [])
  return chatController
}
