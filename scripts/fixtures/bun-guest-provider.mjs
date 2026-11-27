import { readFile, writeFile } from 'node:fs/promises'

export default {
  id: 'fixture',
  async server() {
    if (process.getuid() !== 65534 || Bun.version !== '1.4.2') throw new Error('unexpected runner')
    for (const filename of ['/gateway/private', '/other-plugin/private']) {
      const result = await readFile(filename).then(() => 'read', error => error.code)
      if (result !== 'EACCES') throw new Error('read isolation missing')
    }
    const changed = await writeFile('/plugin/index.mjs', '').then(() => true, () => false)
    if (changed) throw new Error('writable package')
    const network = await fetch('http://192.0.2.1', { signal: AbortSignal.timeout(1000) }).then(() => true, () => false)
    if (network) throw new Error('unexpected network')
    return { auth: { provider: 'fixture-offline' } }
  },
}
