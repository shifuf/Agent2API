// Executed by the actual Bun/Magpie runtime; all HTTP and credentials are synthetic.
export default {
  id: 'full-native-vision',
  async server(input, options) {
    if (!globalThis.Bun?.version || typeof input.magpie.option !== 'function') {
      throw Error('Actual Bun/Magpie runtime required');
    }
    const base = options.upstream;
    const models = { 'wire-native': {
      id: 'wire-native', name: 'Native state fixture',
      api: { id: 'wire-native', url: base + '/v1', npm: '@ai-sdk/openai' },
      limit: { context: 16384, output: 2048 }, tool_call: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
    } };
    return {
      config(config) {
        config.provider['full-native-vision'] = {
          name: 'Native vision fixture', npm: '@ai-sdk/openai', api: base + '/v1', models,
        };
      },
      provider: { id: 'full-native-vision', async models() { return models; } },
      auth: {
        provider: 'full-native-vision', methods: [{ type: 'api', label: 'Synthetic API key' }],
        async loader(getAuth) {
          const auth = await getAuth();
          if (!auth?.key) throw Error('Synthetic account credentials required');
          return { apiKey: auth.key, baseURL: base + '/v1', headers: { 'x-native-fixture-bun': Bun.version } };
        },
      },
    };
  },
};
