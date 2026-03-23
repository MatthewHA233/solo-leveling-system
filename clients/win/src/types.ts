export interface ChronosStep {
  id: string
  minute: number   // 0-1439
  label: string    // "1", "2", ...
  title: string
}

export interface ChronosActivity {
  id: string
  title: string
  category: string
  startMinute: number  // 0-1439
  endMinute: number    // 0-1440
  goalAlignment?: string
  steps: ChronosStep[]
}

export interface BatchThumbnail {
  batchId: string
  startMinute: number
  endMinute: number
  imageUrl?: string
}

export interface TraceLayout {
  activity: ChronosActivity
  trackIndex: number  // 0, 1, 2
}
