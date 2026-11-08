import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as tools from './routing-group-tools.ts'

const group = { id: 'g1', name: 'Daily', model: 'daily', description: '', strategy: 'smart', sticky: 'turn', enabled: true,
  members: [{ id: 'm1', provider: 'a', model: 'Exact/Model', included: true, accounts: ['secret-local-id'], accountScope: 'selected', weight: 3, effort: 'high', fast: true }],
  rules: [{ use: 'm1', more: [], tokens: 10000, folders: ['/private/work'], exceptFolders: ['/private/other'], images: true }] }

test('sharing strips derived data and excludes complete local folder rules without broadening their conditions', () => {
  const portableRule = { use: 'm1', tokens: 20000, images: true }
  const json = tools.exportRoutingGroups([{ ...group, auto: true, hidden: true, revision: 'private',
    rules: [...group.rules, { use: 'm1', tokens: 5000, exceptFolders: ['/private/excluded'] }, portableRule], members: [{ ...group.members[0], token: 'secret' }] }])
  const shared = JSON.parse(json)
  assert.equal(shared.version, 1)
  assert.equal(shared.groups[0].strategy, 'smart')
  assert.equal(shared.groups[0].members[0].weight, 3)
  assert.deepEqual(shared.groups[0].rules, [portableRule])
  for (const value of ['private', 'secret', 'auto', 'hidden', 'revision']) assert.equal(json.includes(value), false, value)
  assert.deepEqual(shared.groups[0].members[0].accounts, [])
  assert.equal(shared.groups[0].members[0].accountScope, 'all')
})

test('import validation rejects unsupported payloads without altering a valid group', () => {
  assert.throws(() => tools.parseRoutingImport('{bad'))
  assert.throws(() => tools.parseRoutingImport(JSON.stringify({ version: 2, groups: [group] })))
  assert.throws(() => tools.parseRoutingImport(JSON.stringify({ version: 1, groups: [{ ...group, members: null }] })))
  assert.deepEqual(tools.parseRoutingImport(JSON.stringify({ version: 1, groups: [group] })), [group])
  const many = Array.from({ length: 100 }, (_, index) => ({ ...group, id: `g${index}` }))
  assert.equal(tools.parseRoutingImport(JSON.stringify({ version: 1, groups: many })).length, 100)
  assert.throws(() => tools.parseRoutingImport(JSON.stringify({ version: 1, groups: [...many, { ...group, id: 'g100' }] })), /100/)
})

test('group search follows nested model manufacturer and connected provider metadata', () => {
  const parent = { ...group, id: 'parent', name: 'Parent', model: 'parent', members: [{ id: 'nested', group: 'g1', provider: '', model: '', accounts: [], included: true }] }
  const catalog = [{ provider: 'a', providerLabel: 'Connected A', model: 'Exact/Model', name: 'Alpha', developer: 'maker', developerName: 'Maker Inc', accountCount: 1, capabilities: {} }]
  for (const query of ['maker inc', 'connected a', 'exact/model']) assert.equal(tools.routingGroupMatches(parent, query, catalog, [group, parent]), true)
  assert.equal(tools.routingGroupMatches(parent, 'unrelated', catalog, [group, parent]), false)
})

test('templates use connected sources and stay unpublished until a draft is saved', () => {
  const choices = [
    { provider: 'ghost', model: 'ghost', accountCount: 0 },
    { provider: 'a', model: 'model-a', accountCount: 2 },
    { provider: 'b', model: 'model-b', accountCount: 1 },
  ]
  const draft = tools.routingTemplate('balanced', choices, 'new-id')
  assert.equal(draft.enabled, false)
  assert.equal(draft.strategy, 'rotate')
  assert.deepEqual(draft.members.map(member => member.provider), ['a', 'b'])
  assert(draft.members.every(member => member.accountScope === 'all' && member.accounts.length === 0))
  assert.equal(group.members[0].accounts[0], 'secret-local-id')
})

test('sharing a nested route includes its dependency and drops rules that only match local folders', () => {
  const parent = { ...group, id: 'parent', members: [{ id: 'nested', provider: '', model: '', group: 'g1', accounts: [], included: true }],
    rules: [{ use: 'nested', folders: ['/private/work'] }] }
  const shared = JSON.parse(tools.exportRoutingGroups([parent], [parent, group]))
  assert.deepEqual(shared.groups.map(item => item.id), ['parent', 'g1'])
  assert.deepEqual(shared.groups[0].rules, [])
})

test('classifier export follows ID prefixed ID and public model dependencies recursively', () => {
  const classifier = { ...group, id: 'classifier-id', model: 'classifier-public', classifier: 'group/g1' }
  for (const reference of ['classifier-id', 'group/classifier-id', 'classifier-public']) {
    const parent = { ...group, id: 'parent', classifier: reference }
    const shared = JSON.parse(tools.exportRoutingGroups([parent], [parent, group, classifier]))
    assert.deepEqual(shared.groups.map(item => item.id), ['parent', 'classifier-id', 'g1'])
    assert.equal(shared.groups[0].classifier, reference)
  }
})

test('derived dynamic members are selectable without changing persisted members or replacing their drafts', () => {
  const before = structuredClone(group)
  const dynamic = { id: 'dynamic-123', provider: 'a', model: 'dynamic-model', included: true, accounts: [], accountScope: 'all' }
  const choices = tools.routingSelectableMembers(group, [{ ...group.members[0], weight: 99 }, dynamic, dynamic])
  assert.deepEqual(choices.map(member => member.id), ['m1', 'dynamic-123'])
  assert.equal(choices[0].weight, 3)
  assert.equal(choices[1].model, 'dynamic-model')
  assert.deepEqual(group, before)
})

test('dynamic choices survive unrelated member edits and unfinished rules while membership changes invalidate them', () => {
  const draft = { ...group, match: ['a/dynamic-*'] }
  const previous = tools.routingMemberExpansionKey(draft)
  const edited = { ...draft, rules: [{ use: 'm1', tokens: 0 }],
    members: draft.members.map(member => ({ ...member, weight: 5, accounts: [], accountScope: 'all', effort: 'max', fast: false, included: false })) }
  assert.equal(tools.routingMemberExpansionKey(edited), previous)
  for (const changed of [
    { ...edited, match: ['a/another-*'] },
    { ...edited, members: edited.members.map(member => ({ ...member, model: 'new-static' })) },
    { ...edited, members: [] },
  ]) assert.notEqual(tools.routingMemberExpansionKey(changed), previous)
})
