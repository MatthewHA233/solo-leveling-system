// ══════════════════════════════════════════════
// 输入坞的模型选择状态（对应 desktop ChatPanel 里 models / freeQuotas / featureModels 那几段）
//
// 和桌面端的差异：
//   · 桌面端 Promise.all 一个失败全丢；手机端额度要联网，各查各的，额度失败不影响显示绑定的模型
//   · 手机端没有 model-free-quota-updated 事件的来源（额度刷新在模型中心里做），改成打开选择器时刷新
//   · 下拉选项本身在 QuickModelSheet（按 modelsForFeature 过滤）；这里只算当前选中的那一项给 chip 显示
// ══════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  getFeatureModel,
  listModelFreeQuotas,
  subscribeFeatureBindingUpdated,
  subscribeModelUsageLogged,
  type ModelFreeQuota,
} from '../../lib/models/model-audit'
import { modelSelectOption } from '../../lib/models/model-display'
import { ensureModelCatalog, hasAllModalities, listCachedModels, type ModelDef } from '../../lib/models/registry'

export type FairyChatFeature = 'fairy_chat' | 'fairy_omni_chat'

const DEFAULT_MODELS: Record<FairyChatFeature, string> = {
  fairy_chat: 'qwen3.6-flash',
  fairy_omni_chat: 'qwen3.5-omni-flash-realtime',
}

function isChatFeature(feature: string | undefined): feature is FairyChatFeature {
  return feature === 'fairy_chat' || feature === 'fairy_omni_chat'
}

export interface FairyModelPicker {
  readonly currentFeature: FairyChatFeature
  readonly currentModel: string
  readonly currentLabel: string
  /** 当前模型免费额度剩余百分比；没有额度信息时 undefined */
  readonly currentMeter: number | undefined
  /** 发图走聊天模型（实时语音模式下打字也是）。不在模型库里的让它试，不支持时接口会报错 */
  readonly chatModelSeesImages: boolean
  readonly chatModelLabel: string
  /** QuickModelSheet 选完后同步本地显示（落库和广播它已经做了） */
  readonly setPicked: (modelId: string) => void
  readonly refreshQuotas: () => void
}

export function useFairyModelPicker(aiMode: 'regular' | 'omni'): FairyModelPicker {
  const [models, setModels] = useState<readonly ModelDef[]>(() => listCachedModels())
  const [freeQuotas, setFreeQuotas] = useState<readonly ModelFreeQuota[]>([])
  const [featureModels, setFeatureModels] = useState<Record<FairyChatFeature, string>>(DEFAULT_MODELS)

  const refreshQuotas = useCallback(() => {
    listModelFreeQuotas().then(setFreeQuotas).catch(() => {})
  }, [])

  useEffect(() => {
    let cancelled = false
    ensureModelCatalog().then((rows) => { if (!cancelled) setModels(rows) }).catch(() => {})
    listModelFreeQuotas().then((rows) => { if (!cancelled) setFreeQuotas(rows) }).catch(() => {})
    Promise.all([
      getFeatureModel('fairy_chat', DEFAULT_MODELS.fairy_chat),
      getFeatureModel('fairy_omni_chat', DEFAULT_MODELS.fairy_omni_chat),
    ]).then(([chatModel, omniModel]) => {
      if (!cancelled) setFeatureModels({ fairy_chat: chatModel, fairy_omni_chat: omniModel })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 别处（模型中心）改了绑定：这里跟着变
  useEffect(() => subscribeFeatureBindingUpdated(({ feature, modelId }) => {
    if (isChatFeature(feature) && modelId) {
      setFeatureModels((prev) => ({ ...prev, [feature]: modelId }))
    }
  }), [])

  // 调用后刷一下额度，让 chip 上的小环跟着更新
  useEffect(() => subscribeModelUsageLogged((call) => {
    if (isChatFeature(call?.feature)) refreshQuotas()
  }), [refreshQuotas])

  const currentFeature: FairyChatFeature = aiMode === 'omni' ? 'fairy_omni_chat' : 'fairy_chat'
  const currentModel = featureModels[currentFeature]
  const option = useMemo(() => {
    const def = models.find((m) => m.id === currentModel)
    if (!def) return null
    return modelSelectOption(def, freeQuotas.find((q) => q.model_id === currentModel))
  }, [models, freeQuotas, currentModel])

  const chatDef = models.find((m) => m.id === featureModels.fairy_chat)

  const setPicked = useCallback((modelId: string) => {
    setFeatureModels((prev) => ({ ...prev, [currentFeature]: modelId }))
  }, [currentFeature])

  return {
    currentFeature,
    currentModel,
    currentLabel: option?.label ?? currentModel,
    currentMeter: option?.meter,
    chatModelSeesImages: !chatDef || hasAllModalities(chatDef, ['image']),
    chatModelLabel: chatDef?.display_name ?? featureModels.fairy_chat,
    setPicked,
    refreshQuotas,
  }
}
