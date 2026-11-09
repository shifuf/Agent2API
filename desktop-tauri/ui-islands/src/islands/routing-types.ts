import { t } from '../i18n'
import type { AccountRecord, AccountSorting, BatchAccountsPayload, BatchAccountsResult } from './accounts-shared'

export type RouteOrderChange = { kind: 'provider' } | { kind: 'account'; provider: string }

export type RouteProviderScope = 'all' | 'selected'

export type RouteProfile = {
  providerScope?: RouteProviderScope
  providers: string[]
  disabledProviders: string[]
  accountOrder: Record<string, string[]>
  excludedAccounts: string[]
  strategy?: string
  sticky?: string
}
export type RoutingRule = { use: string; more?: string[]; useEffort?: string; tokens?: number; images?: boolean; effort?: string;
  agents?: string[]; intent?: string; compact?: boolean; time?: { from: string; to: string; days: string[]; zone: string };
  folders?: string[]; exceptFolders?: string[]; pause?: boolean }
export type RouteMember = { id: string; provider: string; model: string; included: boolean; accounts: string[];
  group?: string; accountScope?: RouteProviderScope; weight?: number; effort?: string; levels?: string[]; fast?: boolean }
export type RouteKind = 'chat' | 'image'
export type RouteGroup = { id: string; name: string; model: string; kind?: RouteKind; description: string; strategy: string; sticky: string; members: RouteMember[];
  enabled?: boolean; auto?: boolean; hidden?: boolean; match?: string[]; pick?: string; sink?: boolean | null; firstToken?: number; patience?: number;
  rules?: RoutingRule[]; classifier?: string; classifierTimeout?: number; effort?: string; context?: number; levels?: string[]; family?: string; unlists?: boolean }
export type RouteModelChoice = { provider: string; providerLabel: string; model: string; name: string; kind?: RouteKind; accountCount: number;
  credits?: string | null;
  developer?: string; developerName?: string; family?: string; canonicalModel?: string; displayName?: string;
  capabilities: { supportsToolCall?: boolean | null; supportsImages?: boolean | null; supportsVideo?: boolean | null; supportsReasoning?: boolean | null; maxInputTokens?: number | null; maxOutputTokens?: number | null } }
export type RouteGroups = { groups: Array<{ group: RouteGroup; revision: string; expandedMembers?: RouteMember[] }>; newRevision: string; catalog: RouteModelChoice[];
  foundGroups?: Array<{ group: RouteGroup; revision: string; expandedMembers?: RouteMember[] }>; autoGroupsEnabled?: boolean; collectionRevision?: string;
  metadata?: { source: string; updatedAt: number; count: number; stale?: boolean; error?: string }; selectedId?: string; importedIds?: string[] }
export type RoutingGroupsAction = { action: string; revision?: string; [key: string]: unknown }
export type RoutingGroupsBridge = Pick<RoutingBridge, 'getRoutingGroups' | 'saveRoutingGroup' | 'routingGroupsAction'>
export type RouteRequestFacts = { tokens?: number; images?: boolean; effort?: string; agent?: string; compact?: boolean; folder?: string; home?: string; atMs?: number }
export type RouteClassification = { intent: string; effort: string }
export type RouteRuleTrace = { groupId: string; cached?: boolean; classifier?: { state: string }; decision: {
  preferred: string[]; excluded: string[]; effortByMember: Record<string, string>; effort?: string | null; intents: string[];
  matched: Array<{ index: number; targets: string[]; pause: boolean; reasons: string[] }>
} }
export type RoutePreviewInput = { model: string; group?: RouteGroup; profile?: RouteProfile; global?: boolean; needs?: { tools?: boolean; images?: boolean; video?: boolean }; failFirst?: boolean;
  facts?: RouteRequestFacts; classification?: RouteClassification }
export type RoutePreview = Pick<RoutingWorkspace, 'model' | 'customized' | 'settings' | 'queue'> & { group?: RouteGroup | null; preview: boolean; rules?: RouteRuleTrace[]; expandedMembers?: RouteMember[] }

export type RouteEntry = {
  candidateId?: string
  memberId?: string | null
  model?: string | null
  id: string
  name: string
  provider: string
  providerLabel?: string
  state: string
  reason: string
  resetAt?: number | null
  priority?: number
}
export type RouteDecision = {
  strategy?: string
  sticky?: string
  stickyHit?: boolean
  picked?: string
  pickedCandidate?: string
  scope?: string
  stickyId?: string
  sessionId?: string
  sessionSource?: string
  configSnapshot?: { groupId?: string; groupName?: string; members?: Array<Omit<RouteMember, 'accounts'> & { accountCount: number }>; capturedAt: number; scope: string; strategy: string; sticky: string; providerScope?: RouteProviderScope; accountCount?: number; providerCount?: number }
  orderedTotal?: number
  blockedTotal?: number
  ordered?: RouteEntry[]
  blocked?: RouteEntry[]
}
export type RouteSettings = {
  routingStrategy: string
  routingSticky: string
  routingFailoverBackoff: boolean
  routingSink: boolean
  routingBreakerEnabled: boolean
  routingBreakerThreshold: number
  routingBreakerTimeoutSeconds: number
  routingBreakerSuccessThreshold: number
}
export type RoutingWorkspace = {
  model: string | null
  customized: boolean
  globalCustomized: boolean
  globalAccountControl?: boolean
  legacyGlobalParticipation?: { revision: string; accounts: Array<{ id: string; name: string; provider: string; providerLabel: string }> } | null
  configuredModels: string[]
  models: string[]
  modelsByProvider?: Record<string, string[]>
  profile: RouteProfile
  inheritedProfile?: RouteProfile
  providers: Array<{ id: string; label: string; accountCount: number; custom: boolean; available: boolean }>
  accounts: AccountRecord[]
  sorting: AccountSorting
  queue: { strategy: string; sticky: string; pickedId: string; ordered: RouteEntry[]; blocked: RouteEntry[]; lastRequestModel?: string }
  settings: RouteSettings
  globalSettings?: RouteSettings
  revision?: string
  accountStates?: Record<string, { model: string; resetAt: number; limitedModels: number }>
  metrics: {
    available?: boolean
    running?: number
    todayRequests?: number
    todaySuccessRate?: number | null
    averageDurationMs?: number | null
    accountRunning?: Record<string, number>
    accountConnections?: Record<string, number>
  }
  gateway: { port: number; host: string }
  stickyCount: number
  updatedAt: number
}
export type RouteAttempt = {
  candidateId?: string
  memberId?: string
  provider?: string
  providerLabel?: string
  account?: string
  accountId?: string
  accountName?: string
  model?: string
  reasoning?: string
  reason?: string
  stickyHit?: boolean
  startedAt?: number | null
  responseAt?: number | null
  finishedAt?: number | null
  status?: number | null
  error?: string | null
  notice?: string | null
  bodyBytes?: number | null
  retries?: Array<{ reason?: string; status?: number | null; delayMs?: number }>
}
export type ReplayRow = {
  traceKey?: string
  id: string
  ts: number
  model: string
  clientModel?: string
  upstreamModel?: string
  provider?: string
  providerLabel?: string
  accountId?: string
  accountName?: string
  client?: string
  clientLabel?: string
  clientEvidence?: import('../../../ui-shared/client-identification').ClientEvidence
  status: number
  error?: string | null
  durationMs?: number
  attempts?: number
  attemptDetails?: RouteAttempt[]
  phase?: string
  phaseStartedAt?: number | null
  phaseElapsedMs?: number | null
  firstResponseMs?: number | null
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  clientReasoning?: string
  upstreamReasoning?: string
  apiKeyName?: string
  apiKeyId?: string
  apiKeySource?: string
  isTest?: boolean
  route?: RouteDecision | null
}
export type StickyEntry = {
  id: string
  keyPreview: string
  model: string
  source: string
  accountId: string
  accountName: string
  provider: string
  providerLabel: string
  createdAt: number
  lastSeen: number
  expiresAt: number
  remainingMs: number
  hits: number
}
export type RoutingBridge = {
  getRoutingGroups(): Promise<RouteGroups>
  saveRoutingGroup(payload: { id: string; group: RouteGroup | null; revision: string }): Promise<RouteGroups>
  routingGroupsAction(payload: RoutingGroupsAction): Promise<RouteGroups>
  previewRouting(payload: RoutePreviewInput): Promise<RoutePreview>
  getRoutingWorkspace(model?: string): Promise<RoutingWorkspace>
  getRoutingFlow(query: import('./routing-flow-types').FlowQuery): Promise<import('./routing-flow-types').FlowSnapshot & import('./routing-flow-types').FlowDetails>
  saveRoutingProfile(payload: { model: string | null; profile: RouteProfile | null; orderChange?: RouteOrderChange; revision?: string } | { migrateGlobalAccounts: string }): Promise<RoutingWorkspace>
  batchAccounts(payload: BatchAccountsPayload): Promise<BatchAccountsResult | null | undefined>
  setRoutingConfig(patch: Partial<RouteSettings>): Promise<RouteSettings>
  getRoutingReplays(query: { model?: string; offset: number; limit: number; status?: string }): Promise<{ entries: ReplayRow[]; matched: number; available?: boolean }>
  getRoutingTrace(query: { model?: string; offset: number; limit: number; status?: string; search?: string; startDate?: string; endDate?: string }): Promise<{ entries: ReplayRow[]; matched: number; available?: boolean }>
  getRoutingTraceRequest(query: { id: string; ts?: number }): Promise<ReplayRow>
  getStatsRequestFilters(): Promise<{ models?: string[] }>
  getRoutingSticky(model?: string): Promise<{ entries: StickyEntry[]; now: number; sticky: string }>
  clearRoutingSticky(payload: { id?: string; model?: string; all?: boolean }): Promise<{ cleared: number }>
  updateAccount(id: string, patch: Record<string, unknown>): Promise<unknown>
}
export type RoutingHost = {
  workbuddyDesktop?: RoutingBridge
  wbApp?: { currentPage?: string; showPage(page: string): void; refresh?(): Promise<void> }
  wbIcons?: { icon(name: string, size?: number): string }
  wbPortPanel?: { gatewayBase(): string; sync?(): Promise<unknown> }
  wbSettingsPanel?: { showCategory(category: string): void }
  wbProviders?: { labelOf(id: string): string }
  wbRequestDetail?: { open(id: string, row: unknown): void; close?(): void }
  wbShell?: { toast(message: string, kind?: string): void }
  wbUnits?: { formatTokens?(value: unknown): string }
}
export const host = () => window as unknown as RoutingHost
export function bridge(): RoutingBridge {
  const api = host().workbuddyDesktop
  if (!api?.getRoutingWorkspace) throw new Error(t('路由接口不可用，请确认网关与界面已更新'))
  return api
}
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export function notify(message: string, kind = 'ok'): void { host().wbShell?.toast(message, kind) }
