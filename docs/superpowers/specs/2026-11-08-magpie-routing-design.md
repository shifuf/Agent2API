# Magpie routing and direct model selection

The user authorized direct implementation and requested the complete routing workflow from `F:/magpie-main/magpie-main`. The earlier AxonHub scope excluded advanced routing; this new request explicitly supersedes that exclusion. References remain read-only. Version 3.4.2, built-in providers, existing credentials and `data/` must be preserved.

## Model selection

Selecting a developer immediately filters an editable, searchable combobox at “对外模型 ID”. Selecting a catalog item fills its ID/name/card without a second picker. Manual IDs remain supported. Existing IDs open the existing model; selecting the current ID preserves the current draft. Custom developer candidates include configured upstreams and saved custom models.

## Routing behavior

Retain the current permission checks, protocol adapters, preview and replay. Extend their shared resolver instead of introducing a second forwarding path. The page offers the complete native Magpie routing surface: automatic same-model groups, named groups, patterns, nested groups, rules and intent classifier, strategies, affinity, first-content timeout, transient-failure patience, member weight/effort/fast controls, metadata/context, enable/disable, hidden members, copy/import/export/templates and live explanations. Magpie plugin execution is outside routing and is not introduced.

Provider means the connected service; developer means the model manufacturer. Metadata comes from the existing public developer catalog plus models.dev, with local cache and safe offline fallbacks. Canonicalization keeps distinct model variants distinct. Automatic groups require the same canonical model on at least two connected providers. No grouping of different models merely because their developer matches.

Existing installations retain manual publication: discovered groups are shown as suggestions until the operator enables automatic groups or saves a suggestion. Automatic grouping does not publish the raw upstream catalog. Existing saved groups and model IDs retain behavior. Enabling automatic groups publishes `auto/<model>` only when eligible accounts exist and Key restrictions allow it. Saved groups override suggestions; hiding an automatic group persists a tombstone. Explicit account lists keep their existing meaning; `accountScope: all` is opt-in and used by dynamic members.

Strategies: `smart`, `order`, `rotate`, `least-used`, `pace`, `free`, `fast`, `weight`, `manual`, plus existing `provider`. The old `usage` value keeps its legacy Rotate interpretation; the new least-used strategy is separately named. Strategies use real quota, token usage and latency observations, falling back to stable order when evidence is absent. Preview reads state without advancing cursors or sending classifier requests. Weight selects members, not proportionally more accounts. Manual selects only its chosen member. Nested groups retain explicit child policies and are bounded to eight levels.

Affinity: auto/session/turn/off/strict. Turn keys follow the most recent user message through tool continuations. Strict never switches a bound route but continues to enforce disabled accounts, Key restrictions and credentials. No strategy, classifier, nested group, pattern or retry may bypass Key scope or custom credential model limits.

Rules support token threshold, image input, minimum reasoning, client, intent, compacting, time/day/timezone, folders and exclusions; pause rules exclude members on every request. Normal decisions are stable within a user turn. Intent classification is bounded, cached and fail-open to normal routing with an explicit trace. Classifiers may use an eligible source model or another group with cycle protection.

First-content deadlines apply before any text/reasoning/tool content is emitted, and only when another eligible candidate exists. Never concatenate partial replies from different upstreams. Patience retries only transient failures under a bounded deadline. Existing failover/backoff/breaker behavior remains a reusable foundation.

## Shared contracts

Existing `RoutingGroup` adds defaulted fields: `enabled` (true for old groups), `auto` (derived), `hidden`, `match: string[]`, `pick: member ID`, `sink: bool?`, `firstToken: seconds`, `patience: seconds` (legacy absent -1; new UI 0=60), `rules: RoutingRule[]`, `classifier: string` (provider/model or group ID), `classifierTimeout: seconds` (8), `effort: string`, `context: number`, `levels: string[]`, `family: string`, `unlists: bool`.

Existing `RoutingMember` adds defaulted `group: string` (nested group ID), `accountScope: selected|all` (selected default), `weight: number` (1), `effort: string`, `levels: string[]`, `fast: bool`. Group members use empty provider and the nested group ID in `group`; explicit source members retain provider/model/accounts. Derived candidates contain stable path identity plus `routingMemberId` (outer member), `routingMemberPath`, `routingModel`, `routingWeight`, `routingEffort`, `routingLevels`, `routingFast`, `routingStrategyPath` and timeout information. All accounts retain original account identity for quota/concurrency.

Rules use Magpie's field names: `use`, `more`, `useEffort`, `tokens`, `images`, `effort`, `agents`, `intent`, `compact`, `time {from,to,days,zone}`, `folders`, `exceptFolders`, `pause`. Targets are member IDs. Pure rule evaluation accepts request facts and optional classifier result, returns preferred/excluded member IDs, effort and explanations. The runtime owns classifier calls, caches and turn identity.

`GET /api/routing/groups` retains groups/revisions/catalog and adds `foundGroups`, `autoGroupsEnabled`, `metadata` status. Group save retains optimistic concurrency. Collection actions provide enable automatic discovery, hide/restore, copy, import/export, templates and reorder with revision validation. Individual save covers toggling group enabled, manual pick and member switches.

## Verification and compatibility

Tests must prove old configuration defaults, disabled/empty groups, nested cycles, dynamic patterns, distinct variants, permission filtering and unavailable accounts. Strategy tests use deterministic observations and cursor behavior. Isolated HTTP fixtures verify selected upstream, failures, classifier fallback, strict/turn identity and first-content commit boundaries. Desktop/mobile browser flows verify direct model selection and routing editors, with existing Key/channel tests retained. Final local service runs the verified executable on port 3065 using the existing data directory.
