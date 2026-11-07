import type { ManagedModel } from './managed-models'
import type { ModelSource } from './public-model-catalog'

export type Translate = (key: string, params?: Record<string, string | number>) => string
export type ModelCatalog = { models: ManagedModel[]; sources: ModelSource[]; revision: string
  routingGroups?: Array<{ id: string; model: string; name: string }> }
export type ModelRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>
export type ModelAction = 'create' | 'enable' | 'disable' | 'archive' | 'restore' | 'delete'

export const modelTypeOptions = (t: Translate) => [
  { id: 'chat', label: t('对话') }, { id: 'embedding', label: t('嵌入') },
  { id: 'rerank', label: t('重排序') }, { id: 'image_generation', label: t('图像生成') },
  { id: 'video_generation', label: t('视频生成') },
]
