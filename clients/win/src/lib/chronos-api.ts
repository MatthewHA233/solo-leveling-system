import { supabase } from './supabase'
import type { ChronosActivity } from '../types'

/** 查询某天的所有活动（含步骤） */
export async function fetchActivities(date: Date): Promise<ChronosActivity[]> {
  const dateStr = date.toISOString().slice(0, 10)

  const { data: rows, error } = await supabase
    .from('chronos_activities')
    .select(`
      id,
      title,
      category,
      start_minute,
      end_minute,
      goal_alignment,
      chronos_steps (
        id,
        minute,
        label,
        title
      )
    `)
    .eq('date', dateStr)
    .order('start_minute')

  if (error) throw error
  if (!rows) return []

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    startMinute: r.start_minute,
    endMinute: r.end_minute,
    goalAlignment: r.goal_alignment ?? undefined,
    steps: (r.chronos_steps ?? []).map((s: { id: string; minute: number; label: string; title: string }) => ({
      id: s.id,
      minute: s.minute,
      label: s.label,
      title: s.title,
    })),
  }))
}

/** 插入一条活动（含步骤） */
export async function createActivity(
  date: Date,
  activity: Omit<ChronosActivity, 'id'>,
): Promise<string> {
  const dateStr = date.toISOString().slice(0, 10)

  const { data, error } = await supabase
    .from('chronos_activities')
    .insert({
      date: dateStr,
      title: activity.title,
      category: activity.category,
      start_minute: activity.startMinute,
      end_minute: activity.endMinute,
      goal_alignment: activity.goalAlignment ?? null,
    })
    .select('id')
    .single()

  if (error) throw error

  if (activity.steps.length > 0) {
    const { error: stepError } = await supabase
      .from('chronos_steps')
      .insert(
        activity.steps.map((s) => ({
          activity_id: data.id,
          minute: s.minute,
          label: s.label,
          title: s.title,
        })),
      )
    if (stepError) throw stepError
  }

  return data.id
}

/** 删除一条活动（级联删除步骤） */
export async function deleteActivity(id: string): Promise<void> {
  const { error } = await supabase
    .from('chronos_activities')
    .delete()
    .eq('id', id)
  if (error) throw error
}
