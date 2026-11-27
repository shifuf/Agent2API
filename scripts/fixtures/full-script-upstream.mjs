import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export async function fullScriptUpstream() {
  const keys = { a: 'disposable-a-' + randomUUID(), b: 'disposable-b-' + randomUUID() };
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      const parts = []; for await (const part of request) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString() || '{}');
      const account = Object.keys(keys).find(id => request.headers.authorization === 'Bearer ' + keys[id]);
      calls.push({ path: request.url, account, bun: request.headers['x-fixture-bun'],
        hook: request.headers['x-fixture-hook'], body: request.url === '/authorize' ? { account: body.account } : body });
      const json = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/authorize') {
        if (!keys[body.account] || body.key !== keys[body.account]) return json(401, { error: 'invalid fixture credentials' });
        return json(200, { uid: 'fixture-user-' + body.account, email: body.account + '@acceptance.invalid' });
      }
      if (!account) return json(401, { error: 'missing fixture credentials' });
      if (request.url === '/v1/models') return json(200, { data: ['wire-common', 'wire-' + account].map(id => ({ id })) });
      if (request.url !== '/v1/chat/completions') return json(404, { error: 'unknown fixture route' });
      assert.equal(body.stream, true, 'The script bridge must request a real stream even when the client aggregates');
      assert.equal(request.headers['x-fixture-hook'], 'executed');
      assert.ok(['wire-common', 'wire-' + account].includes(body.model), 'Account-specific catalog must be enforced');
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const event = (delta, finish_reason = null, usage) => response.write('data: ' + JSON.stringify({
        id: 'full-script-upstream', object: 'chat.completion.chunk', model: body.model,
        choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
      }) + '\n\n');
      event({ role: 'assistant' });
      event({ reasoning_content: 'fixture reasoning preserved' });
      const result = body.messages.find(message => message.role === 'tool');
      if (body.tools?.length && !result) {
        event({ tool_calls: [{ index: 0, id: 'call_fixture_add', type: 'function', function: { name: 'add', arguments: '{"a":' } }] });
        event({ tool_calls: [{ index: 0, function: { arguments: '2,"b":3}' } }] });
        event({}, 'tool_calls', { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 });
      } else {
        if (result) assert.equal(result.tool_call_id, 'call_fixture_add');
        event({ content: result ? 'tool result=' + result.content : account + ':' + body.model });
        event({}, 'stop', { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26 });
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      calls.push({ error: error.message });
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { keys, calls, base: 'http://127.0.0.1:' + server.address().port,
    async stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
