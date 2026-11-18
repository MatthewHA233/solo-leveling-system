// ══════════════════════════════════════════════
// 昼夜表的「计划」底部弹窗：浮岛与日程 / 计划安排 两页（对应 desktop 右侧栏 components/daynight/PlanSidePanel.tsx）
//   desktop 的切换键在底部（顶上右角是外层面板的关闭键）；手机端放顶部，和其他底部弹窗一样上面是把手
//   计划安排里点一条任务 = 选它当画笔，并关掉弹窗回昼夜表去涂
// ══════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react'
import { Animated, Dimensions, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ActivityPalette, PlanNode } from '../../types'
import type { Island, IslandPlacement } from '../../lib/islands/island-model'
import { theme } from '../../theme'
import IslandPanel from './IslandPanel'
import PlanTodoPanel from './PlanTodoPanel'

export interface PlanSheetProps {
  visible: boolean
  onClose: () => void
  selectedDate: Date
  palette: ActivityPalette
  islands: readonly Island[]
  placements: readonly IslandPlacement[]
  islandsError: string | null
  onIslandsChanged: () => void
  /** 当前清单（selectedProjectTagId）下的任务 */
  planNodes: PlanNode[]
  selectedProjectTagId: number | null
  selectedPlanNodeId: number | null
  onSelectProject: (id: number) => void
  onSelectNode: (id: number | null) => void
  onNodesChange: (projectTagId?: number) => void
  onPlanBlocksMayChange: () => void
  /** 点任务卡片 = 选它当画笔去涂（弹窗随后关掉）；新建任务时的自动选中走 onSelectNode，不算 */
  onPickNode: (id: number) => void
  initialPage?: 'islands' | 'todo'
}

type Page = 'islands' | 'todo'

const PAGES: ReadonlyArray<{ readonly id: Page; readonly label: string }> = [
  { id: 'islands', label: '主线浮岛日程' },
  { id: 'todo', label: '计划安排' },
]

export default function PlanSheet({
  visible,
  onClose,
  selectedDate,
  palette,
  islands,
  placements,
  islandsError,
  onIslandsChanged,
  planNodes,
  selectedProjectTagId,
  selectedPlanNodeId,
  onSelectProject,
  onSelectNode,
  onNodesChange,
  onPlanBlocksMayChange,
  onPickNode,
  initialPage,
}: PlanSheetProps) {
  const [page, setPage] = useState<Page>(initialPage ?? 'islands')

  // 每次打开按调用方要的页面开（比如从「选任务」入口进来直接到计划安排）
  useEffect(() => {
    if (visible && initialPage) setPage(initialPage)
  }, [visible, initialPage])

  // 蒙版用 Modal 的 fade 原地淡入；面板单独从底部滑上来
  const slide = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!visible) return
    slide.setValue(0)
    Animated.timing(slide, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [visible, slide])
  const sheetOffset = Dimensions.get('window').height * 0.3

  const pick = (id: number) => {
    onPickNode(id)
    onClose()
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
          <Animated.View
            style={[
              styles.sheet,
              { transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [sheetOffset, 0] }) }] },
            ]}
          >
            <View style={styles.handle} />
            <View style={styles.tabs}>
              {PAGES.map((p) => {
                const active = page === p.id
                return (
                  <Pressable key={p.id} onPress={() => setPage(p.id)} style={[styles.tab, active && styles.tabActive]}>
                    <Text style={[styles.tabText, active && styles.tabTextActive]}>{p.label}</Text>
                  </Pressable>
                )
              })}
            </View>
            <View style={styles.body}>
              {page === 'islands' ? (
                <IslandPanel
                  selectedDate={selectedDate}
                  palette={palette}
                  islands={islands}
                  placements={placements}
                  loadError={islandsError}
                  onChanged={onIslandsChanged}
                />
              ) : (
                <PlanTodoPanel
                  selectedDate={selectedDate}
                  palette={palette}
                  nodes={planNodes}
                  selectedProjectTagId={selectedProjectTagId}
                  selectedPlanNodeId={selectedPlanNodeId}
                  onSelectProject={onSelectProject}
                  onSelectNode={onSelectNode}
                  onNodesChange={onNodesChange}
                  onPlanBlocksMayChange={onPlanBlocksMayChange}
                  onPick={pick}
                />
              )}
            </View>
          </Animated.View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: 'rgba(20, 21, 26, 0.35)', justifyContent: 'flex-end' },
  sheet: {
    height: '82%', backgroundColor: theme.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16,
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: theme.line, marginTop: 10, marginBottom: 12 },
  tabs: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: theme.sunk, marginBottom: 14 },
  tab: { flex: 1, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: theme.surface },
  tabText: { fontSize: 13, color: theme.inkSoft, fontWeight: '600' },
  tabTextActive: { color: theme.ink },
  body: { flex: 1, paddingBottom: 8 },
})
