# 昼夜表究极响应式设计

**日期：** 2026-04-13

---

## 问题

当前 DayNightChart 只有两档硬编码模式（`isExpanded: bool`）：
- 展开：60min/列，24 列，cellW=80，cellH=50
- 收缩：30min/列，48 列，cellW=160，cellH=100

无法适配更小的容器，且两档之间跳变。

---

## 设计目标

5min/格始终不变。变化的是 **`rowsPerCol`**（每列放几行 × 5min）。

当 colsPerHour > 1 时，用**小时组视觉边界**让用户始终感知"1小时在哪儿"。

---

## 档位表

| rowsPerCol | minPerCol | colsPerHour | 总列数 | cellW | cellH |
|-----------|-----------|-------------|--------|-------|-------|
| 12        | 60min     | 1           | 24     | 80    | 50    |
| 6         | 30min     | 2           | 48     | 52    | 36    |
| 4         | 20min     | 3           | 72     | 36    | 26    |
| 3         | 15min     | 4           | 96     | 26    | 20    |
| 2         | 10min     | 6           | 144    | 18    | 14    |
| 1         | 5min      | 12          | 288    | 12    | 10    |

---

## 自动档位选择

用 `ResizeObserver` 监听 canvas 容器宽度，选择满足以下条件的最大 `rowsPerCol`：

```
totalW(rowsPerCol) <= containerWidth
```

其中 `totalW` = hPad + totalCols × (cellW + colGap) + hourGroupGap × 24

---

## 小时组分隔符

当 `colsPerHour > 1` 时：
- 每个小时组左侧画一条竖向分隔线（颜色 `#2a4070`，贯穿格子区）
- 小时标签（`Xh`）跨整个组宽，左对齐显示在组底部

当 `colsPerHour = 1` 时：保持现有行为（标签直接在列下方）。

---

## 实现范围

- 修改 `getGridParams`，输入由 `isExpanded: bool` 改为 `containerWidth: number`，自动计算所有参数
- 添加 `ResizeObserver` 监听容器宽度
- 修改 canvas 绘制逻辑：小时组左边界线 + 跨组标签
- 保留 `isExpanded` prop 作为"是否允许自动响应"的开关（false = 固定在当前两档之一）

---

## 不在范围内

- 改变格子形状或布局方向
- 触摸/手势缩放
- 垂直方向的响应式（行数不变）
