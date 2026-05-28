export type BiliActionKind =
  | 'splash'
  | 'home'
  | 'video_intro'
  | 'fullscreen'
  | 'comments'
  | 'comment_detail'

export type TorrentActionRange = {
  key: string
  startTs: number
  endTs: number
  kind: BiliActionKind
  title?: string
  upName?: string
  isStory?: boolean
}
