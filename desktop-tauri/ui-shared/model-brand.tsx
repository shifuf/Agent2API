import { useState, type CSSProperties } from 'react'
import './model-brand.css'

// Only bundled assets are used. Catalog metadata never becomes an arbitrary image URL.
const files = [
  'openai.png', 'anthropic.png', 'deepseek.png', 'grok.svg', 'gemini-cli.svg', 'qwenwork.svg', 'kimi-work.svg',
  'minimax.png', 'glm.png', 'nvidia.png', 'huggingface.png', 'modelscope.png', 'siliconflow.png', 'openrouter.png',
  'workbuddy.png', 'raccoon.png', 'catpaw.png', 'autoclaw.png', 'qoder.png', 'cline.png', 'accio.png', 'zcode.png',
  'codearts.png', 'trae.png', 'loomy.png', 'kuku.png', 'monkeycode.png', 'commandcode.png', 'antigravity.png',
  'officeace.png', 'orcaterm.png', 'chatglm.png', 'tabbit.png', 'atomcode.png', 'lobsterai.png', 'doubaowork.png',
  'cursor.svg', 'kiro.svg', 'astudio.png', 'devin.svg', 'factory.svg', 'zed.svg', 'minimax-code.svg',
  'opendesign.svg', 'nous-portal.svg', 'copilot.svg', 'volcengine-ark.png', 'sensenova.png', 'ollama-local.png',
  'xiaomi-tokenplan.png', 'alicode.png', 'alims-intl.png', 'alitp-intl.png', 'newapi.png', 'sub2api.png',
  'opencode-zen.png', 'opencode-go.png',
]
const assets = new Map(files.map(file => [file.replace(/\.(png|svg)$/, ''), file]))
const aliases: Record<string, string> = {
  xai: 'grok', 'x-ai': 'grok', google: 'gemini-cli', gemini: 'gemini-cli', 'google-deepmind': 'gemini-cli',
  claude: 'anthropic', 'claude-subscription': 'anthropic', 'codex-subscription': 'openai', 'chatgpt-subscription': 'openai',
  'copilot-subscription': 'copilot', 'gemini-subscription': 'gemini-cli', qwen: 'qwenwork', alibaba: 'qwenwork',
  'alibaba-cloud': 'qwenwork', dashscope: 'qwenwork', moonshot: 'kimi-work', moonshotai: 'kimi-work', kimi: 'kimi-work',
  'z-ai': 'glm', zai: 'glm', zhipu: 'glm', zhipuai: 'glm', zhipu_ai: 'glm', '智谱': 'glm', '智谱ai': 'glm',
  bytedance: 'doubaowork', doubao: 'doubaowork', volcengine: 'volcengine-ark', 'deepseek-web': 'deepseek',
  'hugging-face': 'huggingface', nvidia_nim: 'nvidia', ollama: 'ollama-local', xiaomi: 'xiaomi-tokenplan',
  'cline-free': 'cline', 'cline-pass': 'cline', 'qwenwork-enterprise': 'qwenwork', 'minimax-code-global': 'minimax-code',
}
const assetFor = (value: string) => {
  const id = value.trim().toLowerCase()
  const alias = aliases[id] || id.replace(/-(?:intl|cn)$/, '')
  return assets.get(id) || assets.get(alias)
}

export function ModelBrand({ id = '', name = '', icon = '', size = 'normal' }: {
  id?: string; name?: string; icon?: string; size?: 'small' | 'normal' | 'large'
}) {
  const asset = assetFor(icon) || assetFor(id) || assetFor(name)
  const [failed, setFailed] = useState('')
  const seed = id || name || 'custom'
  const hue = [...seed].reduce((hash, char) => (hash * 31 + char.codePointAt(0)!) % 360, 0)
  return <span className={`model-brand model-brand-${size}`} style={{ '--model-brand-hue': hue } as CSSProperties} aria-hidden='true'>
    {asset && failed !== asset
      ? <img src={`assets/providers/${asset}`} alt='' onError={() => setFailed(asset)} />
      : <span>{[...(name || id || '◇')][0].toUpperCase()}</span>}
  </span>
}
