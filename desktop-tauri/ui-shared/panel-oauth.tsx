import * as React from 'react'

export type OAuthProvider = 'google'|'github'
type Client = { enabled:boolean; clientId:string; hasSecret:boolean; bound:boolean }
export type OAuthSettings = {origin:string;google:Client;github:Client}
export type OAuthPatch = {provider:OAuthProvider;enabled?:boolean;origin?:string;clientId?:string;secret?:string;unbind?:boolean}
export type OAuthApi = {load():Promise<OAuthSettings>;save(patch:OAuthPatch):Promise<OAuthSettings>}
export const providerName=(provider:OAuthProvider)=>provider==='google'?'Google':'GitHub'

export async function beginOAuth(provider:OAuthProvider,mode:'bind'|'login',captcha?:string|null) {
  if (location.protocol!=='https:') throw Error('HTTPS required')
  const response=await fetch('/api/panel/oauth/start',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider,mode,captcha:captcha||null})})
  if (!response.ok) throw Error('OAuth unavailable')
  const result=await response.json();const url=new URL(result?.data?.url)
  if (url.origin!==(provider==='google'?'https://accounts.google.com':'https://github.com'))throw Error('Invalid OAuth destination')
  location.assign(url.href)
}

export function OAuthEditor({api,identity,t,native=false}:{api:OAuthApi;identity():string;t(key:string):string;native?:boolean}) {
  const scope=identity();const [settings,setSettings]=React.useState<OAuthSettings|null>(null),[provider,setProvider]=React.useState<OAuthProvider>('github')
  const [enabled,setEnabled]=React.useState(false),[client,setClient]=React.useState(''),[secret,setSecret]=React.useState(''),[origin,setOrigin]=React.useState(''),[busy,setBusy]=React.useState(false),[message,setMessage]=React.useState('')
  function apply(value:OAuthSettings,target:OAuthProvider){setSettings(value);setEnabled(value[target].enabled);setClient(value[target].clientId);setOrigin(value.origin);setSecret('')}
  React.useEffect(()=>{let live=true;void Promise.resolve().then(()=>api.load()).then(value=>{if(live && scope===identity() && value?.github&&value?.google)apply(value,'github')}).catch(()=>{});return()=>{live=false}},[api,scope,identity])
  if(!settings)return null
  const current=settings[provider],web=!native && location.protocol==='https:' && settings.origin===location.origin
  async function run(action:'save'|'unbind'|'bind'){if(busy||identity()!==scope)return;setBusy(true);setMessage('');try{
    if(action==='bind'){await beginOAuth(provider,'bind');return}
    if(action==='unbind' && !window.confirm(t('解除此身份的面板登录权限？')))return
    const value=await api.save(action==='unbind'?{provider,unbind:true}:{provider,enabled,origin,clientId:client,...(secret?{secret}:{})});if(scope===identity()){apply(value,provider);setMessage(t('已保存'))}
  }catch{if(scope===identity())setMessage(t('OAuth 操作失败，请检查配置及网页会话'))}finally{if(scope===identity())setBusy(false)}}
  return <section className='settings-panel' data-panel-oauth=''><h3>{t('第三方身份登录')}</h3>
    <label>{t('提供商')} <select disabled={busy} value={provider} onChange={event=>{const next=event.currentTarget.value as OAuthProvider;setProvider(next);apply(settings,next);setMessage('')}}><option value='github'>GitHub</option><option value='google'>Google</option></select></label>
    <label><input type='checkbox' checked={enabled} onChange={event=>setEnabled(event.currentTarget.checked)}/> {t('启用')}</label>
    <label>{t('面板的固定 HTTPS 来源')}<input type='url' value={origin} autoComplete='off' onChange={event=>setOrigin(event.currentTarget.value)}/></label>
    <div>Redirect URI: <code>{origin.replace(/\/$/,'')}/api/panel/oauth/{provider}/callback</code></div>
    <label>Client ID <input value={client} maxLength={256} onChange={event=>setClient(event.currentTarget.value)}/></label>
    <label>Client secret <input type='password' autoComplete='new-password' value={secret} maxLength={1024} onChange={event=>setSecret(event.currentTarget.value)}/></label>
    {current.hasSecret && <small>{t('密钥已保存；留空保持不变')}</small>}
    <div><button className='btn' type='button' disabled={busy} onClick={()=>void run('save')}>{t('保存')}</button>{' '}
    <button className='btn' type='button' disabled={busy || (!current.bound && (!web || !current.enabled))} onClick={()=>void run(current.bound?'unbind':'bind')}>{current.bound?t('解除绑定'):t('绑定身份')}</button></div>
    <p>{t('仅已绑定的身份可登录。请在固定 HTTPS 面板的浏览器会话中绑定；密码登录始终保留。')}</p>{message&&<p role='status'>{message}</p>}
  </section>
}
