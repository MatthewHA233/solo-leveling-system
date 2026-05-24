// ══════════════════════════════════════════════
// SoloDb 种子数据 —— 首次启动 SoloDb 空表时导入
//
// sync_id / createdAt / lastUsedAt 均与 desktop solo.db
// 2026-05-23 dump 一致，让 LAN sync 接入后能按 sync_id 直接合并，
// 不会因为业务键不一致或时间戳过新覆盖 desktop 历史。
// ══════════════════════════════════════════════

import {
  soloListCategories,
  soloListTags,
  soloUpsertCategory,
  soloUpsertTag,
  type CategoryRow,
} from './solodb'

export interface SeedReport {
  before: { cats: number; tags: number }
  after: { cats: number; tags: number }
  wroteCats: number
  wroteTags: number
  skippedTags: number
  errors: string[]
}

/**
 * 启动时 + 每次 fetchPalette 兜底调用。
 * upsert 本身幂等（ON CONFLICT），所以反复调用安全。
 * 只在 categories OR tags 数量不足时才真正 seed，正常情况下早退。
 * 返回 SeedReport 方便 UI 直接显示诊断（logcat 不一定能拿到 console 输出）。
 */
export async function seedSoloDbIfEmpty(): Promise<SeedReport | null> {
  try {
    const [cats0, tags0] = await Promise.all([soloListCategories(), soloListTags()])
    if (cats0.length >= SEED_CATEGORIES.length && tags0.length >= SEED_TAGS.length) {
      return {
        before: { cats: cats0.length, tags: tags0.length },
        after: { cats: cats0.length, tags: tags0.length },
        wroteCats: 0, wroteTags: 0, skippedTags: 0, errors: [],
      }
    }
    return await seedAll(cats0.length, tags0.length)
  } catch (e: any) {
    return {
      before: { cats: -1, tags: -1 }, after: { cats: -1, tags: -1 },
      wroteCats: 0, wroteTags: 0, skippedTags: 0,
      errors: [`seedSoloDbIfEmpty: ${e?.message ?? String(e)}`],
    }
  }
}

async function seedAll(beforeCats: number, beforeTags: number): Promise<SeedReport> {
  const errors: string[] = []
  let wroteCats = 0
  for (const c of SEED_CATEGORIES) {
    try {
      await soloUpsertCategory({
        name: c.name, color: c.color, sortOrder: c.sortOrder,
        syncId: c.syncId, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt,
      })
      wroteCats++
    } catch (e: any) {
      errors.push(`cat ${c.name}: ${e?.message ?? String(e)}`)
    }
  }
  const catRows = await soloListCategories()
  const catIdByName = new Map(catRows.map((r) => [r.name, r.id]))

  let wroteTags = 0
  let skippedTags = 0
  for (const t of SEED_TAGS) {
    const catName = t.fullPath.split(',')[0]
    const categoryId = catIdByName.get(catName)
    if (categoryId == null) {
      skippedTags++
      errors.push(`tag ${t.fullPath}: catName "${catName}" not found`)
      continue
    }
    try {
      await soloUpsertTag({
        categoryId,
        fullPath: t.fullPath, leafName: t.leafName, depth: t.depth,
        syncId: t.syncId, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt,
      })
      wroteTags++
    } catch (e: any) {
      errors.push(`tag ${t.fullPath}: ${e?.message ?? String(e)}`)
    }
  }
  const [catsAfter, tagsAfter] = await Promise.all([soloListCategories(), soloListTags()])
  return {
    before: { cats: beforeCats, tags: beforeTags },
    after: { cats: catsAfter.length, tags: tagsAfter.length },
    wroteCats, wroteTags, skippedTags,
    errors: errors.slice(0, 5),
  }
}

type SeedCategory = Pick<CategoryRow, 'syncId' | 'name' | 'color' | 'sortOrder' | 'createdAt' | 'lastUsedAt'>

const SEED_CATEGORIES: SeedCategory[] = [
  { syncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', name: '编程', color: '#38BDF8', sortOrder: 1, createdAt: '2026-05-08 19:48:00', lastUsedAt: '2026-05-20 00:50:56' },
  { syncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', name: '社交', color: '#E879F9', sortOrder: 2, createdAt: '2026-05-08 21:34:06', lastUsedAt: '2026-05-19 16:58:41' },
  { syncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', name: '娱乐', color: '#FB7185', sortOrder: 3, createdAt: '2026-05-08 22:00:43', lastUsedAt: '2026-05-20 00:44:42' },
  { syncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', name: '生活', color: '#F97316', sortOrder: 4, createdAt: '2026-05-08 22:31:58', lastUsedAt: '2026-05-19 22:28:13' },
  { syncId: 'b0cec8ff-b33f-4540-81a5-22ead0211a12', name: '睡觉', color: '#84CC16', sortOrder: 5, createdAt: '2026-05-09 00:28:25', lastUsedAt: '2026-05-13 15:26:39' },
  { syncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', name: '设备杂项', color: '#FACC15', sortOrder: 6, createdAt: '2026-05-09 09:24:05', lastUsedAt: '2026-05-19 22:07:20' },
  { syncId: 'f391e881-113b-411c-94a1-4bfcfbe23bf9', name: '身边杂项', color: '#F97316', sortOrder: 7, createdAt: '2026-05-09 10:41:59', lastUsedAt: '2026-05-18 20:28:06' },
  { syncId: '058cecd5-b411-4408-b010-7526951cfa5f', name: '未知探索', color: '#2DD4BF', sortOrder: 8, createdAt: '2026-05-09 10:55:46', lastUsedAt: '2026-05-13 12:30:25' },
  { syncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', name: '工作', color: '#22C55E', sortOrder: 9, createdAt: '2026-05-13 11:37:53', lastUsedAt: '2026-05-19 15:18:44' },
]

interface SeedTag {
  syncId: string
  categorySyncId: string
  fullPath: string
  leafName: string
  depth: number
  createdAt: string
  lastUsedAt: string
}

const SEED_TAGS: SeedTag[] = [
  { syncId: 'd434237b-da18-4e49-83fd-727311c56069', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程', leafName: '氛围编程', depth: 2, createdAt: '2026-05-08 19:48:15', lastUsedAt: '2026-05-08 19:50:18' },
  { syncId: 'ad35a061-4808-4646-bd81-294a9b6893cc', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目', leafName: 'solo-leveling-system项目', depth: 3, createdAt: '2026-05-08 20:47:47', lastUsedAt: '2026-05-18 19:49:11' },
  { syncId: 'b7a3f773-5217-4ea6-be24-b86419106151', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,使用记录相关的功能', leafName: '使用记录相关的功能', depth: 4, createdAt: '2026-05-08 20:48:12', lastUsedAt: '2026-05-18 20:33:53' },
  { syncId: '5bd6c7e6-f479-480f-b9e0-d8c2d2ae7c69', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,尝试美化UI界面', leafName: '尝试美化UI界面', depth: 4, createdAt: '2026-05-09 09:58:10', lastUsedAt: '2026-05-13 10:00:27' },
  { syncId: '5de0d0d4-0a24-4fb3-982d-bd6a15f7f729', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,用工具链精细还原特色UI', leafName: '用工具链精细还原特色UI', depth: 4, createdAt: '2026-05-09 11:29:13', lastUsedAt: '2026-05-20 00:50:56' },
  { syncId: '2601c466-a278-4abd-9187-da6f5f052920', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,移植到macos', leafName: '移植到macos', depth: 4, createdAt: '2026-05-13 14:32:53', lastUsedAt: '2026-05-16 13:58:56' },
  { syncId: '44ccc5d8-a204-4665-9f23-b054027b864e', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,移植到手机', leafName: '移植到手机', depth: 4, createdAt: '2026-05-13 17:24:51', lastUsedAt: '2026-05-17 12:53:26' },
  { syncId: '2b5b1b72-38f1-4d4f-af87-598d0ac76c4a', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,编译包相关改动', leafName: '编译包相关改动', depth: 4, createdAt: '2026-05-13 18:11:45', lastUsedAt: '2026-05-13 18:52:38' },
  { syncId: 'a43944bb-5801-4c80-9417-bcf3de130cfa', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,局域网多端同步功能', leafName: '局域网多端同步功能', depth: 4, createdAt: '2026-05-18 17:22:32', lastUsedAt: '2026-05-18 17:22:35' },
  { syncId: 'f398a48e-1bde-43d3-9c97-d627970c7f11', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,宝哥的转盘App', leafName: '宝哥的转盘App', depth: 3, createdAt: '2026-05-18 18:10:27', lastUsedAt: '2026-05-20 00:37:11' },
  { syncId: '916fea26-216d-4f68-846a-1ec0ee79e310', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,新功能探讨计划', leafName: '新功能探讨计划', depth: 4, createdAt: '2026-05-18 20:48:59', lastUsedAt: '2026-05-18 21:24:15' },
  { syncId: '2babfdaf-ca82-4441-bbec-b8cab4a19e80', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,主面板开新', leafName: '主面板开新', depth: 4, createdAt: '2026-05-18 21:32:07', lastUsedAt: '2026-05-18 23:09:08' },
  { syncId: '1f1ed93e-1873-4aa4-8036-e148f1cb8c99', categorySyncId: '503810d0-d2be-4d1a-bc89-4df1a40b29cf', fullPath: '编程,氛围编程,solo-leveling-system项目,动机仪表盘相关功能', leafName: '动机仪表盘相关功能', depth: 4, createdAt: '2026-05-18 22:43:02', lastUsedAt: '2026-05-18 22:54:31' },
  { syncId: '645fdb2c-6ff4-4999-a8a8-354b9a0b294c', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,QQ聊天', leafName: 'QQ聊天', depth: 2, createdAt: '2026-05-08 21:34:17', lastUsedAt: '2026-05-08 21:34:17' },
  { syncId: '697e6b61-48b9-4716-8e4e-8cff8d4ebb3e', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,QQ聊天,和女朋友聊天', leafName: '和女朋友聊天', depth: 3, createdAt: '2026-05-08 21:34:30', lastUsedAt: '2026-05-19 11:56:51' },
  { syncId: '6735cdc6-7a2d-4dd1-ae97-d5b89d85ecae', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,QQ聊天,和朋友们聊天', leafName: '和朋友们聊天', depth: 3, createdAt: '2026-05-08 23:11:56', lastUsedAt: '2026-05-13 21:23:36' },
  { syncId: 'aa6d03dd-4b71-457b-992e-35be795fa4f8', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,家里来客', leafName: '家里来客', depth: 2, createdAt: '2026-05-09 17:41:52', lastUsedAt: '2026-05-09 17:41:52' },
  { syncId: '9beabf70-1ec7-4185-9bcb-e591db597aaa', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,家里来客,招待客人', leafName: '招待客人', depth: 3, createdAt: '2026-05-09 17:41:57', lastUsedAt: '2026-05-09 17:42:01' },
  { syncId: '9e17441b-49a5-470a-ab82-4cc1371f417f', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,家人沟通', leafName: '家人沟通', depth: 2, createdAt: '2026-05-09 19:03:13', lastUsedAt: '2026-05-09 19:03:13' },
  { syncId: '00b035ff-cb4b-42d4-b111-6d2a0315e819', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,家人沟通,和家人交际', leafName: '和家人交际', depth: 3, createdAt: '2026-05-09 19:03:40', lastUsedAt: '2026-05-10 18:32:30' },
  { syncId: '75ff5510-36ae-4492-9d4d-10d0d22e89f0', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,QQ聊天,广告抽奖模拟器', leafName: '广告抽奖模拟器', depth: 3, createdAt: '2026-05-13 16:31:53', lastUsedAt: '2026-05-13 16:31:58' },
  { syncId: 'c305e1b7-e8db-4bd7-b0ca-37e7fdc4f9c7', categorySyncId: '0e9a11e9-602c-4967-8197-d8a2b956552e', fullPath: '社交,QQ聊天,和宝哥沟通', leafName: '和宝哥沟通', depth: 3, createdAt: '2026-05-19 14:56:39', lastUsedAt: '2026-05-19 16:58:41' },
  { syncId: 'ec14a7f0-4d11-4258-b130-8299468d8d2c', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,玩手机', leafName: '玩手机', depth: 2, createdAt: '2026-05-08 22:01:12', lastUsedAt: '2026-05-08 22:01:12' },
  { syncId: 'ad5d22c0-917d-4fe5-8445-5a7313ca4634', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,玩手机,随缘玩手机', leafName: '随缘玩手机', depth: 3, createdAt: '2026-05-08 22:01:25', lastUsedAt: '2026-05-19 21:39:21' },
  { syncId: 'b504c116-d72b-47c8-b67a-16bb8c08065d', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,游戏', leafName: '游戏', depth: 2, createdAt: '2026-05-08 23:00:04', lastUsedAt: '2026-05-08 23:00:04' },
  { syncId: '78251aa0-25bd-4ff0-ae3b-780615b6ef67', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,游戏,玩PTCG', leafName: '玩PTCG', depth: 3, createdAt: '2026-05-08 23:00:17', lastUsedAt: '2026-05-19 23:49:04' },
  { syncId: '0bfe59fa-4f1c-40b8-8ad9-2078ad0afe3c', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,游戏,玩崩铁', leafName: '玩崩铁', depth: 3, createdAt: '2026-05-08 23:38:47', lastUsedAt: '2026-05-19 23:53:04' },
  { syncId: '33d96e4b-3fe1-4226-af5d-84b1b153f368', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,游戏,玩鸣潮', leafName: '玩鸣潮', depth: 3, createdAt: '2026-05-08 23:46:10', lastUsedAt: '2026-05-20 00:44:42' },
  { syncId: '4350c3e5-3857-4ddd-b8d1-966a775226e5', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,人之常情...', leafName: '人之常情...', depth: 2, createdAt: '2026-05-09 11:13:35', lastUsedAt: '2026-05-19 11:49:22' },
  { syncId: 'e4c6f26e-8c02-48ab-864b-2a1ad6c1f731', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,玩手机,看b站视频', leafName: '看b站视频', depth: 3, createdAt: '2026-05-09 13:29:24', lastUsedAt: '2026-05-18 22:12:41' },
  { syncId: 'b407a1af-1200-4a7b-8f20-e19300f86947', categorySyncId: 'ebfbfdd9-fb39-42de-8ec7-dccc2958b9c3', fullPath: '娱乐,游戏,玩绝区零', leafName: '玩绝区零', depth: 3, createdAt: '2026-05-10 00:57:50', lastUsedAt: '2026-05-20 00:08:27' },
  { syncId: '1bd5fd7a-dd34-4a5f-a8ab-f057c6bdd879', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,身体清洁类', leafName: '身体清洁类', depth: 2, createdAt: '2026-05-08 22:32:18', lastUsedAt: '2026-05-08 22:32:18' },
  { syncId: 'a6ced5c4-0386-443b-9e2f-f4e1d8fc00a0', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,身体清洁类,洗澡', leafName: '洗澡', depth: 3, createdAt: '2026-05-08 22:32:33', lastUsedAt: '2026-05-19 22:28:13' },
  { syncId: '6b71f408-415c-4a7e-b2be-87f91cae8320', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒', leafName: '吃喝拉撒', depth: 2, createdAt: '2026-05-09 09:34:14', lastUsedAt: '2026-05-09 09:34:14' },
  { syncId: 'f0ee252f-6e3a-499d-b0aa-148de4c1509d', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,上厕所', leafName: '上厕所', depth: 3, createdAt: '2026-05-09 09:34:19', lastUsedAt: '2026-05-13 11:33:25' },
  { syncId: 'fb0c5744-74e4-4ba3-9f07-1ec23eca132d', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,做饭', leafName: '做饭', depth: 3, createdAt: '2026-05-09 13:41:35', lastUsedAt: '2026-05-09 13:41:35' },
  { syncId: 'f5f55357-9edc-4dfe-acc2-20fed1326836', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,煮面条', leafName: '煮面条', depth: 3, createdAt: '2026-05-09 13:41:48', lastUsedAt: '2026-05-19 12:40:37' },
  { syncId: '3ea70260-451c-42fd-8dd9-48f643bb8295', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,吃饭', leafName: '吃饭', depth: 3, createdAt: '2026-05-09 13:42:03', lastUsedAt: '2026-05-19 19:09:30' },
  { syncId: '7490980e-63bd-46c9-a7cb-ccad5f033e0a', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,家务', leafName: '家务', depth: 2, createdAt: '2026-05-09 14:05:45', lastUsedAt: '2026-05-09 14:05:45' },
  { syncId: '55484216-554d-4a3c-99eb-b7a7092e539b', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,家务,洗碗', leafName: '洗碗', depth: 3, createdAt: '2026-05-09 14:05:51', lastUsedAt: '2026-05-19 15:49:51' },
  { syncId: '6d165cf4-7a5c-47c5-bdcb-1ab526f47210', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,家务,扔垃圾', leafName: '扔垃圾', depth: 3, createdAt: '2026-05-09 19:36:03', lastUsedAt: '2026-05-19 19:31:34' },
  { syncId: '1dd3b955-c56a-4a8f-b6d7-bb4d53e03ba4', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,身体清洁类,刷牙等', leafName: '刷牙等', depth: 3, createdAt: '2026-05-10 09:44:16', lastUsedAt: '2026-05-19 11:04:34' },
  { syncId: '2feea219-a75a-4223-8be1-7f7b6d044c78', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,出门', leafName: '出门', depth: 2, createdAt: '2026-05-10 18:31:37', lastUsedAt: '2026-05-10 18:31:37' },
  { syncId: 'd470b9fe-30a6-4b74-a48a-7e0ed4715ae9', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,出门,出门(市内)', leafName: '出门(市内)', depth: 3, createdAt: '2026-05-10 18:31:56', lastUsedAt: '2026-05-10 18:32:22' },
  { syncId: 'c9051267-1b7c-43f4-beb8-f2071b6c5a4d', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,家务,清洁厕所', leafName: '清洁厕所', depth: 3, createdAt: '2026-05-13 17:58:46', lastUsedAt: '2026-05-13 17:58:48' },
  { syncId: 'cfc69198-e71e-4afe-8009-4313331e5eeb', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,家常,点蚊香', leafName: '点蚊香', depth: 3, createdAt: '2026-05-18 22:30:25', lastUsedAt: '2026-05-18 22:30:27' },
  { syncId: '3442d8cc-35b3-457c-a15b-9987123d7d07', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,身体清洁类,刮胡子', leafName: '刮胡子', depth: 3, createdAt: '2026-05-19 12:02:25', lastUsedAt: '2026-05-19 12:02:29' },
  { syncId: '1b0f634a-5b26-4d9e-b405-155cb977ac13', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,泡咖啡', leafName: '泡咖啡', depth: 3, createdAt: '2026-05-19 16:43:18', lastUsedAt: '2026-05-19 16:43:21' },
  { syncId: '25bb5c0e-d727-4d9b-8d43-788d41488bf7', categorySyncId: '5dbb3262-7777-4fba-a64e-ba4ee9cd8557', fullPath: '生活,吃喝拉撒,换衣服', leafName: '换衣服', depth: 3, createdAt: '2026-05-19 19:25:10', lastUsedAt: '2026-05-19 19:25:19' },
  { syncId: '37e839f7-1713-420f-b8d7-4bda9c06d339', categorySyncId: 'b0cec8ff-b33f-4540-81a5-22ead0211a12', fullPath: '睡觉,夜晚睡眠', leafName: '夜晚睡眠', depth: 2, createdAt: '2026-05-09 00:28:35', lastUsedAt: '2026-05-10 10:55:32' },
  { syncId: 'a509350e-c0b9-44ff-87af-461fd52797b5', categorySyncId: 'b0cec8ff-b33f-4540-81a5-22ead0211a12', fullPath: '睡觉,下午觉', leafName: '下午觉', depth: 2, createdAt: '2026-05-09 15:06:42', lastUsedAt: '2026-05-13 15:26:39' },
  { syncId: '2d3b7fad-1835-4b49-b5da-261c556ef555', categorySyncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', fullPath: '设备杂项,电脑杂项', leafName: '电脑杂项', depth: 2, createdAt: '2026-05-09 09:24:13', lastUsedAt: '2026-05-09 09:24:13' },
  { syncId: '25c1499c-e1f8-40de-9d97-bcedf426db82', categorySyncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', fullPath: '设备杂项,电脑杂项,电脑启动后杂项', leafName: '电脑启动后杂项', depth: 3, createdAt: '2026-05-09 09:24:23', lastUsedAt: '2026-05-13 09:59:10' },
  { syncId: '0657d9b1-0528-4a73-8558-0d9d65859a03', categorySyncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', fullPath: '设备杂项,电脑杂项,claude或codex类杂项', leafName: 'claude或codex类杂项', depth: 3, createdAt: '2026-05-09 09:37:55', lastUsedAt: '2026-05-19 21:56:49' },
  { syncId: 'e1dc8fab-d23a-4c2c-991d-263d5d2f1288', categorySyncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', fullPath: '设备杂项,电脑杂项,折腾代理', leafName: '折腾代理', depth: 3, createdAt: '2026-05-09 22:14:36', lastUsedAt: '2026-05-13 19:20:30' },
  { syncId: 'f3838e76-cfa1-445b-83e1-8d51d54c5e31', categorySyncId: '6caa89c6-c222-4c8e-9f07-a5694c83fed0', fullPath: '设备杂项,电脑杂项,清理存储空间', leafName: '清理存储空间', depth: 3, createdAt: '2026-05-19 22:07:17', lastUsedAt: '2026-05-19 22:07:20' },
  { syncId: '19793a67-44b9-4bee-bc97-d811711b0660', categorySyncId: 'f391e881-113b-411c-94a1-4bfcfbe23bf9', fullPath: '身边杂项,踱步想问题', leafName: '踱步想问题', depth: 2, createdAt: '2026-05-09 10:42:23', lastUsedAt: '2026-05-18 20:28:06' },
  { syncId: '623616e6-c478-4e4f-8ea8-6ee428d94dc6', categorySyncId: 'f391e881-113b-411c-94a1-4bfcfbe23bf9', fullPath: '身边杂项,查看存款现金', leafName: '查看存款现金', depth: 2, createdAt: '2026-05-13 18:05:02', lastUsedAt: '2026-05-13 18:05:04' },
  { syncId: 'e27bc5d3-0c74-4716-bb89-46c65fa67501', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目实现方案', leafName: '探索项目实现方案', depth: 2, createdAt: '2026-05-09 10:55:59', lastUsedAt: '2026-05-09 10:55:59' },
  { syncId: '41bd7a83-539c-47be-a579-e729cc61817a', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目实现方案,探索科幻UI交互实现', leafName: '探索科幻UI交互实现', depth: 3, createdAt: '2026-05-09 10:56:24', lastUsedAt: '2026-05-13 12:30:25' },
  { syncId: '77bb6c9f-fd49-49d6-9ef2-e429bd7afb06', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目盈利', leafName: '探索项目盈利', depth: 2, createdAt: '2026-05-10 15:57:05', lastUsedAt: '2026-05-10 15:57:05' },
  { syncId: '2fa78824-b87e-4de6-9daa-a47a975d1c4b', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目盈利,探索营业执照挂靠', leafName: '探索营业执照挂靠', depth: 3, createdAt: '2026-05-10 15:57:19', lastUsedAt: '2026-05-10 16:22:54' },
  { syncId: '4b30575e-b89c-4fda-b113-f1d2e1290715', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目盈利,探索OPC一人公司社区', leafName: '探索OPC一人公司社区', depth: 3, createdAt: '2026-05-10 17:33:02', lastUsedAt: '2026-05-10 17:33:10' },
  { syncId: '25781207-dbdb-48f2-8cb0-28bf713c0b06', categorySyncId: '058cecd5-b411-4408-b010-7526951cfa5f', fullPath: '未知探索,探索项目实现方案,复盘科幻UI实现', leafName: '复盘科幻UI实现', depth: 3, createdAt: '2026-05-13 12:20:34', lastUsedAt: '2026-05-13 12:20:39' },
  { syncId: 'f675cc9f-60d7-46a4-96a1-b4c1f358a98d', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,创业', leafName: '创业', depth: 2, createdAt: '2026-05-13 11:38:24', lastUsedAt: '2026-05-13 11:38:24' },
  { syncId: '6bb6474d-0cff-44a8-a03e-e51df8e0c873', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,创业,公共事务', leafName: '公共事务', depth: 3, createdAt: '2026-05-13 11:38:43', lastUsedAt: '2026-05-13 11:38:43' },
  { syncId: '09ba634e-cd77-4dfb-ad47-90c7a04f4bb3', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,创业,公共事务,OPC社区申请入驻相关', leafName: 'OPC社区申请入驻相关', depth: 4, createdAt: '2026-05-13 11:39:02', lastUsedAt: '2026-05-13 12:10:34' },
  { syncId: '6d79f08d-f452-427c-b355-06ff96e376f3', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,闲时项目', leafName: '闲时项目', depth: 2, createdAt: '2026-05-13 16:31:17', lastUsedAt: '2026-05-13 16:31:17' },
  { syncId: 'd1ecd6d7-301a-4f42-bb80-163c6c42ba91', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,闲时项目,抽奖模拟器更新配置', leafName: '抽奖模拟器更新配置', depth: 3, createdAt: '2026-05-13 16:31:28', lastUsedAt: '2026-05-13 17:58:13' },
  { syncId: 'c0c76f3b-c4dd-4afa-8d39-ea80e15340e2', categorySyncId: '51bd2da8-01b2-4073-9040-fd3f18dc7c86', fullPath: '工作,宝哥的项目,宝哥的转盘App测试', leafName: '宝哥的转盘App测试', depth: 3, createdAt: '2026-05-19 15:18:44', lastUsedAt: '2026-05-19 15:18:44' },
]
