import { Checkbox, Input, Label } from '@ui'
import { useState } from 'react'
import type { ModelCard } from './managed-models'
import type { Translate } from './models-types'

/** Model information is descriptive; it never overrides upstream capabilities. */
export function ModelCardFields({ card, onChange, t }: { card: ModelCard; onChange: (card: ModelCard) => void; t: Translate }) {
  const [inputModalities, setInputModalities] = useState(card.modalities?.input?.join(', ') || '')
  const [outputModalities, setOutputModalities] = useState(card.modalities?.output?.join(', ') || '')
  const numeric = (group: 'cost' | 'limit', key: string, label: string, integral = false) => {
    const value = (card[group] as Record<string, number> | undefined)?.[key]
    return <div className='models-field' key={`${group}-${key}`}><Label htmlFor={`model-${group}-${key}`}>{label}</Label>
      <Input id={`model-${group}-${key}`} type='number' min='0' step={integral ? '1' : 'any'} value={value ?? ''}
        onChange={event => onChange({ ...card, [group]: { ...card[group], [key]: event.target.value === '' ? undefined : Number(event.target.value) } })} /></div>
  }
  return <section className='models-card-fields'>
    <div><h3>{t('模型卡片')}</h3><p className='text-xs text-subtle'>{t('目录会自动填入已知信息，可按需修改。实际能力以关联的上游模型为准。')}</p></div>
    <div className='models-card-options'>
      <label><Checkbox checked={!!card.reasoning?.supported} onCheckedChange={value => onChange({ ...card, reasoning: { ...card.reasoning, supported: !!value } })} />{t('推理能力')}</label>
      <label><Checkbox checked={!!card.toolCall} onCheckedChange={value => onChange({ ...card, toolCall: !!value })} />{t('工具调用')}</label>
      <label><Checkbox checked={!!card.vision} onCheckedChange={value => onChange({ ...card, vision: !!value })} />{t('视觉能力')}</label>
      <label><Checkbox checked={!!card.temperature} onCheckedChange={value => onChange({ ...card, temperature: !!value })} />{t('温度参数')}</label>
    </div>
    <div className='models-field-grid'>
      {numeric('limit', 'context', t('上下文长度'), true)}{numeric('limit', 'output', t('最大输出长度'), true)}
    </div>
    <h4>{t('每百万 Token 价格（美元）')}</h4>
    <div className='models-field-grid'>
      {numeric('cost', 'input', t('输入价格'))}{numeric('cost', 'output', t('输出价格'))}
      {numeric('cost', 'cacheRead', t('缓存读取价格'))}{numeric('cost', 'cacheWrite', t('缓存写入价格'))}
    </div>
    <div className='models-field-grid'>
      <div className='models-field'><Label htmlFor='model-input-modalities'>{t('输入模态')}</Label><Input id='model-input-modalities' value={inputModalities} placeholder='text, image'
        onChange={event => { setInputModalities(event.target.value); onChange({ ...card, modalities: { ...card.modalities, input: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } }) }} /></div>
      <div className='models-field'><Label htmlFor='model-output-modalities'>{t('输出模态')}</Label><Input id='model-output-modalities' value={outputModalities} placeholder='text'
        onChange={event => { setOutputModalities(event.target.value); onChange({ ...card, modalities: { ...card.modalities, output: event.target.value.split(',').map(value => value.trim()).filter(Boolean) } }) }} /></div>
      <div className='models-field'><Label htmlFor='model-knowledge'>{t('知识截止日期')}</Label><Input id='model-knowledge' value={card.knowledge || ''} placeholder='YYYY-MM'
        onChange={event => onChange({ ...card, knowledge: event.target.value })} /></div>
      <div className='models-field'><Label htmlFor='model-release'>{t('发布日期')}</Label><Input id='model-release' value={card.releaseDate || ''} placeholder='YYYY-MM-DD'
        onChange={event => onChange({ ...card, releaseDate: event.target.value })} /></div>
    </div>
  </section>
}
