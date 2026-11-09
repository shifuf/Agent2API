import type { RouteGroup, RouteMember, RouteModelChoice, RoutingRule } from './routing-types'

export const routingStrategies = ['smart', 'order', 'rotate', 'least-used', 'pace', 'free', 'fast', 'weight', 'manual', 'provider'] as const
export const routingEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Expansion depends on model identities. Editing weight, accounts or an unfinished
// rule must retain the resolved choices even while the full draft cannot preview.
export const routingMemberExpansionKey = (group?: RouteGroup) => JSON.stringify(group ? [group.id, group.kind || 'chat', group.match || [],
  group.members.map(member => [member.id, member.provider, member.model, member.group || '']).sort((left, right) => left[0].localeCompare(right[0]))] : null)

export function routingSelectableMembers(group: RouteGroup, expandedMembers: RouteMember[] = []): RouteMember[] {
  const members = new Map(group.members.map(member => [member.id, member]))
  for (const member of expandedMembers) if (!members.has(member.id)) members.set(member.id, member)
  return [...members.values()]
}

export function routingGroupMatches(group: RouteGroup, search: string, catalog: RouteModelChoice[], groups: RouteGroup[], visited = new Set<string>()): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true
  if (visited.has(group.id)) return false
  visited.add(group.id)
  if ([group.name, group.model, group.description, group.family, ...(group.match || [])].join(' ').toLowerCase().includes(query)) return true
  return group.members.some(member => {
    if (member.group) {
      const child = groups.find(item => item.id === member.group)
      return child ? routingGroupMatches(child, query, catalog, groups, visited) : member.group.toLowerCase().includes(query)
    }
    const choice = catalog.find(item => item.provider === member.provider && item.model === member.model)
    return [member.provider, member.model, choice?.providerLabel, choice?.name, choice?.developer, choice?.developerName, choice?.canonicalModel, choice?.displayName]
      .join(' ').toLowerCase().includes(query)
  })
}

export function exportRoutingGroups(groups: RouteGroup[], available = groups): string {
  const selected = new Map<string, RouteGroup>()
  const include = (group: RouteGroup) => {
    if (selected.has(group.id)) return
    selected.set(group.id, group)
    for (const member of group.members) {
      const nested = member.group && available.find(item => item.id === member.group)
      if (nested) include(nested)
    }
    const classifierId = group.classifier?.replace(/^group\//, '')
    const classifier = available.find(item => item.id === classifierId) || available.find(item => item.model === group.classifier)
    if (classifier) include(classifier)
  }
  groups.forEach(include)
  const portable = [...selected.values()].map(group => {
    const result: RouteGroup = { id: group.id, name: group.name, model: group.model, description: group.description, strategy: group.strategy, sticky: group.sticky,
      members: group.members.map(member => ({ id: member.id, provider: member.provider, model: member.model, included: member.included, accounts: [],
        group: member.group, accountScope: 'all', weight: member.weight, effort: member.effort, levels: member.levels, fast: member.fast })) }
    for (const key of ['kind', 'enabled', 'match', 'pick', 'sink', 'firstToken', 'patience', 'classifier', 'classifierTimeout', 'effort', 'context', 'levels', 'family', 'unlists'] as const) {
      if (group[key] !== undefined) Object.assign(result, { [key]: group[key] })
    }
    result.rules = group.rules?.filter(rule => !rule.folders?.length && !rule.exceptFolders?.length).map(rule => {
      const clean: RoutingRule = { use: rule.use }
      for (const key of ['more', 'useEffort', 'tokens', 'images', 'effort', 'agents', 'intent', 'compact', 'time', 'pause'] as const) {
        if (rule[key] !== undefined) Object.assign(clean, { [key]: rule[key] })
      }
      return clean
    })
    return result
  })
  return JSON.stringify({ version: 1, groups: portable }, null, 2)
}

export function parseRoutingImport(text: string): RouteGroup[] {
  const data = JSON.parse(text)
  if (!data || data.version !== 1 || !Array.isArray(data.groups)) throw new Error('请输入 version: 1 的路由组 JSON。')
  if (!data.groups.length || data.groups.length > 100) throw new Error('每次可导入 1 到 100 个路由组')
  for (const group of data.groups) {
    if (!group || !['id', 'name', 'model', 'strategy', 'sticky'].every(key => typeof group[key] === 'string')
      || !Array.isArray(group.members) || group.members.length > 256 || group.members.some((member: Record<string, unknown>) => !member || typeof member.id !== 'string' || !Array.isArray(member.accounts))) {
      throw new Error('路由组或成员格式不正确。')
    }
  }
  return data.groups
}

export function routingTemplate(kind: string, choices: RouteModelChoice[], id: string): RouteGroup {
  const connected = choices.filter(choice => choice.accountCount > 0 && (choice.kind || 'chat') === 'chat')
  const title = kind === 'balanced' ? '均衡分担' : kind === 'fast' ? '低延迟优先' : kind === 'budget' ? '免费优先' : '顺序回退'
  return { id, kind: 'chat', name: title, model: `group-${id.slice(0, 8)}`, description: '', strategy: kind === 'balanced' ? 'rotate' : kind === 'fast' ? 'fast' : kind === 'budget' ? 'free' : 'order',
    sticky: 'auto', enabled: false, patience: 0, firstToken: kind === 'fast' ? 15 : 0, rules: [], match: [],
    members: connected.slice(0, 8).map((choice, index) => ({ id: `${id}-${index}`, provider: choice.provider, model: choice.model, included: true, accounts: [], accountScope: 'all', weight: 1 })) }
}
