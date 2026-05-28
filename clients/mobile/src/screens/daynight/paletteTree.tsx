import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { alpha, theme } from '../../theme'
import type { ActivityCategory, ActivityTag } from '../../types'

export type TagTreeNode = {
  segment: string
  fullPath: string
  tag: ActivityTag | null
  children: TagTreeNode[]
  catColor: string
}

export function buildTagTree(
  tags: ActivityTag[],
  categories: ActivityCategory[],
): TagTreeNode[] {
  const catByName = new Map(categories.map((c) => [c.name, c]))
  const roots: TagTreeNode[] = []
  const rootByName = new Map<string, TagTreeNode>()
  for (const cat of categories) {
    const r: TagTreeNode = {
      segment: cat.name,
      fullPath: cat.name,
      tag: null,
      children: [],
      catColor: cat.color,
    }
    roots.push(r)
    rootByName.set(cat.name, r)
  }
  for (const tag of tags) {
    const parts = tag.fullPath.split(',')
    const cat = catByName.get(parts[0])
    if (!cat) continue
    let node = rootByName.get(parts[0])!
    for (let i = 1; i < parts.length; i++) {
      const seg = parts[i]
      let child = node.children.find((c) => c.segment === seg)
      if (!child) {
        child = {
          segment: seg,
          fullPath: parts.slice(0, i + 1).join(','),
          tag: null,
          children: [],
          catColor: cat.color,
        }
        node.children.push(child)
      }
      node = child
    }
    node.tag = tag
  }

  const recencyOf = (n: TagTreeNode): string => {
    let best = n.tag?.lastUsedAt ?? ''
    for (const c of n.children) {
      const r = recencyOf(c)
      if (r > best) best = r
    }
    return best
  }
  const sortRec = (n: TagTreeNode) => {
    n.children.sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))
    for (const c of n.children) sortRec(c)
  }
  for (const r of roots) sortRec(r)
  return roots
    .filter((r) => r.children.length > 0 || r.tag != null)
    .sort((a, b) => recencyOf(b).localeCompare(recencyOf(a)))
}

function PaletteGlyph({ color = '#888', size = 14 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3a9 9 0 0 0 0 18h1.3a1.7 1.7 0 0 0 1.2-2.9 1.7 1.7 0 0 1 1.2-2.9H17a4 4 0 0 0 0-8z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M7.5 10h.01M10 7.5h.01M14 7.5h.01M6.8 14h.01" stroke={color} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  )
}

export function TagTreeView({
  node,
  depth,
  selectedId,
  onPick,
  onPickPath,
  onOpenCategoryColor,
  onLongPressTag,
  onLongPressCategory,
}: {
  node: TagTreeNode
  depth: number
  selectedId: number | null
  onPick: (id: number) => void
  onPickPath?: (fullPath: string) => void
  onOpenCategoryColor?: (categoryName: string) => void
  onLongPressTag: (tag: ActivityTag) => void
  onLongPressCategory: (categoryName: string) => void
}) {
  if (depth > 0 && node.children.length === 0 && node.tag) {
    const on = node.tag.id === selectedId
    const c = node.catColor
    return (
      <Pressable
        onPress={() => {
          if (onPickPath) onPickPath(node.fullPath)
          else onPick(node.tag!.id)
        }}
        onLongPress={() => onLongPressTag(node.tag!)}
        delayLongPress={400}
        style={[
          treeStyles.leafChip,
          {
            backgroundColor: on ? alpha(c, 0.38) : alpha(c, 0.22),
            borderColor: on ? c : alpha(c, 0.55),
          },
          on && treeStyles.leafChipOn,
        ]}
      >
        <Text style={[treeStyles.leafText, on && treeStyles.leafTextOn]}>
          {node.segment}
        </Text>
      </Pressable>
    )
  }

  const leafKids = node.children.filter((c) => c.children.length === 0 && c.tag)
  const branchKids = node.children.filter((c) => c.children.length > 0)
  const onHeader = node.tag != null && node.tag.id === selectedId
  return (
    <View
      style={[
        treeStyles.box,
        {
          backgroundColor: alpha(node.catColor, depth === 0 ? 0.1 : 0.06),
          borderColor: alpha(node.catColor, depth === 0 ? 0.55 : 0.35),
          borderLeftWidth: depth === 0 ? 4 : 2,
        },
      ]}
    >
      <View style={treeStyles.headerRow}>
        <Pressable
          onPress={() => {
            if (onPickPath) onPickPath(node.fullPath)
            else if (node.tag) onPick(node.tag.id)
          }}
          onLongPress={() => {
            if (depth === 0) onLongPressCategory(node.segment)
            else if (node.tag) onLongPressTag(node.tag)
          }}
          delayLongPress={400}
          style={treeStyles.headerPickArea}
        >
          <View
            style={[
              treeStyles.headerDot,
              { backgroundColor: node.catColor },
            ]}
          />
          <Text
            style={[
              depth === 0 ? treeStyles.catHeader : treeStyles.branchHeader,
              onHeader && { fontWeight: '800', textDecorationLine: 'underline' },
            ]}
          >
            {node.segment}
          </Text>
        </Pressable>
        {depth === 0 && onOpenCategoryColor && (
          <Pressable
            hitSlop={8}
            onPress={() => onOpenCategoryColor(node.segment)}
            style={[treeStyles.paletteBtn, { borderColor: alpha(node.catColor, 0.45), backgroundColor: alpha(node.catColor, 0.1) }]}
          >
            <PaletteGlyph color={node.catColor} size={14} />
          </Pressable>
        )}
      </View>
      {leafKids.length > 0 && (
        <View style={treeStyles.leafRow}>
          {leafKids.map((c) => (
            <TagTreeView
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              selectedId={selectedId}
              onPick={onPick}
              onPickPath={onPickPath}
              onOpenCategoryColor={onOpenCategoryColor}
              onLongPressTag={onLongPressTag}
              onLongPressCategory={onLongPressCategory}
            />
          ))}
        </View>
      )}
      {branchKids.map((c) => (
        <TagTreeView
          key={c.fullPath}
          node={c}
          depth={depth + 1}
          selectedId={selectedId}
          onPick={onPick}
          onPickPath={onPickPath}
          onOpenCategoryColor={onOpenCategoryColor}
          onLongPressTag={onLongPressTag}
          onLongPressCategory={onLongPressCategory}
        />
      ))}
    </View>
  )
}

const treeStyles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 9,
    marginBottom: 8,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  headerPickArea: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flexShrink: 1,
    minWidth: 0,
  },
  headerDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  paletteBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  catHeader: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.4,
    color: theme.ink,
  },
  branchHeader: {
    fontSize: 12.5,
    fontWeight: '600',
    color: theme.ink,
  },
  leafRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  leafChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 13,
    borderWidth: 1,
  },
  leafChipOn: {
    borderWidth: 1.5,
  },
  leafText: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.ink,
  },
  leafTextOn: {
    fontWeight: '700',
  },
})
