import * as React from 'react'

export type MaintenanceRun = { startedAt:number; finishedAt:number|null; status:'succeeded'|'failed'|'running'|'interrupted'; trigger:'manual'|'scheduled' }

export function MaintenanceHistory({ runs,t }: { runs?:MaintenanceRun[]; t(key:string):string }) {
  if (!runs?.length) return null
  const statuses={succeeded:t('成功'),failed:t('失败'),running:t('执行中…'),interrupted:t('已中断')}
  return <details data-maintenance-history=''><summary>{t('维护执行历史')}</summary><ol>{runs.map(run=><li key={run.startedAt}>
    <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>{' · '}
    {run.trigger==='manual'?t('手动'):t('定时')}{' · '}{statuses[run.status]}{run.finishedAt!==null && ` · ${Math.max(0,run.finishedAt-run.startedAt)/1000} s`}
  </li>)}</ol></details>
}
