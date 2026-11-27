// This is an actual OpenCode/Magpie plugin, installed and executed by Bun.
// All credentials and HTTP requests belong to the disposable acceptance server.
export default {
  id: 'full-script-acceptance',
  async server(input, options) {
    if (!globalThis.Bun?.version || typeof input.magpie.option !== 'function') {
      throw new Error('The real Bun and Magpie host are required');
    }
    const base = options.upstream;
    const model = id => ({ id, name: id, api: { id, url: base + '/v1', npm: '@ai-sdk/openai-compatible' },
      limit: { context: 16384, output: 2048 }, tool_call: true, reasoning: true,
      modalities: { input: ['text'], output: ['text'] } });
    return {
      config(config) {
        config.provider['full-script-acceptance'] = {
          name: options.title || 'Full script acceptance', npm: '@ai-sdk/openai-compatible', api: base + '/v1',
          models: { 'wire-common': model('wire-common') },
        };
      },
      provider: {
        id: 'full-script-acceptance',
        async models(_info, { auth, signal }) {
          const response = await fetch(base + '/v1/models', {
            headers: { authorization: 'Bearer ' + auth.key, 'x-fixture-bun': Bun.version }, signal,
          });
          if (!response.ok) throw new Error('Fixture catalog HTTP ' + response.status);
          const result = await response.json();
          return Object.fromEntries(result.data.map(item => [item.id, model(item.id)]));
        },
      },
      auth: {
        provider: 'full-script-acceptance',
        options: [{ key: 'extended', label: 'Extended catalog', default: false }],
        methods: [{ type: 'api', label: 'Disposable upstream API key',
          prompts: [{ type: 'text', key: 'key', label: 'API Key', required: true, secret: true },
            { type: 'text', key: 'account', label: 'Account', required: true }],
          async authorize(values, { signal }) {
            const response = await fetch(base + '/authorize', {
              method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-bun': Bun.version },
              body: JSON.stringify(values), signal,
            });
            if (!response.ok) return { type: 'failed', error: 'Disposable upstream rejected credentials' };
            const identity = await response.json();
            return { type: 'success', key: values.key, uid: identity.uid, metadata: { email: identity.email } };
          },
        }],
        async loader(getAuth) {
          const auth = await getAuth();
          if (!auth?.key) throw new Error('Persisted account credentials are required');
          return { apiKey: auth.key, baseURL: base + '/v1', headers: { 'x-fixture-bun': Bun.version } };
        },
      },
      async 'chat.headers'(_request, result) { result.headers['x-fixture-hook'] = 'executed'; },
    };
  },
};
