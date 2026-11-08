import * as React from 'react'
import { bridge, type RouteGroup, type RouteGroups, type RouteMember, type RoutingBridge } from './routing-types'
import { routingMemberExpansionKey as signature } from './routing-group-tools'

const desktopPreview: RoutingBridge['previewRouting'] = input => bridge().previewRouting(input)

/** Derived choices follow the current draft; expanded members never enter saved members. */
export function useRoutingPreviewMembers(group: RouteGroup | undefined, data: RouteGroups | null, api = desktopPreview) {
  const [latest, setLatest] = React.useState<{ signature: string; members: RouteMember[] } | null>(null)
  const sequence = React.useRef(0)
  const preview = React.useCallback<RoutingBridge['previewRouting']>(async input => {
    const request = ++sequence.current
    const result = await api(input)
    if (request === sequence.current) setLatest({ signature: signature(input.group), members: result.expandedMembers || [] })
    return result
  }, [api])
  const current = signature(group)
  const saved = [...(data?.groups || []), ...(data?.foundGroups || [])].find(row => signature(row.group) === current)
  return { preview, expandedMembers: latest?.signature === current ? latest.members : saved?.expandedMembers || [] }
}
