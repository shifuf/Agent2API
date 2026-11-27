import { useEffect, useRef, useState } from 'react'
import { Button, Card } from '@ui'
import { apiCall } from '../api/client'
import { t } from '../i18n'

type PhaseSetting = { thirdPartyReasoningCollapse: boolean }
const endpoint = '/api/reasoning-collapse'

export function ResponsesPhaseSetting() {
  const [value, setValue] = useState<boolean | null>(null)
  const [working, setWorking] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  async function load(next?: boolean) {
    const current = ++generation.current
    setWorking(true)
    setError('')
    try {
      const result = await apiCall<PhaseSetting>(endpoint, next === undefined ? {} : { method: 'PUT', body: { thirdPartyReasoningCollapse: next } })
      if (generation.current === current) setValue(result.thirdPartyReasoningCollapse)
    } catch (failure) {
      if (generation.current === current) { setValue(null); setError(failure instanceof Error ? failure.message : t('不可用')) }
    } finally {
      if (generation.current === current) setWorking(false)
    }
  }
  useEffect(() => { void load(); return () => { generation.current++ } }, [])
  return <Card className='m-card'><div className='m-row'>
    <div className='m-grow'><div className='m-t1'>{t('第三方模型回答完自动折叠过程')}</div>
      <div className='m-t2'>{error || t('给 Codex 的响应补阶段标记，回答完后像官方模型一样把推理与命令过程折叠起来')}</div></div>
    {value === null ? <Button disabled={working} variant='ghost' onClick={() => void load()}>{working ? t('检测中…') : t('刷新')}</Button>
      : <input aria-label={t('第三方模型回答完自动折叠过程')} type='checkbox' checked={value} disabled={working} onChange={event => void load(event.currentTarget.checked)} />}
  </div></Card>
}
