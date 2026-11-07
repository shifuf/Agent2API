# AxonHub management page and workflow parity

The user requests that model management, custom-channel creation and gateway Key selection follow the local AxonHub reference. They explicitly clarified the scope as **page layouts and adding/selecting models, channels and Keys**, excluding advanced association rules/priorities, multiple Key profiles, quotas and IP controls. Direct implementation remains authorized.

## Behavior

- Preserve all built-in Agent/Web provider registrations and login flows. The accounts page offers both adding an existing built-in account and adding a custom channel. API template shortcuts open the same custom-channel editor with that provider preselected.
- The custom-channel editor includes a provider/template selector beside its basic fields. Key-group editing and the supported-model overview are distinct sections. Group model discovery, selection, manual IDs and fetching all groups expand contextual panels. Fetched candidates stay scoped to their credential and require explicit confirmation. A channel with credentials and no selected models can be saved; an empty group grants no model access.
- Model management follows AxonHub's developer-grouped table, model information editor and separate channel-association operation. Basic model fields include developer, ID, display name, icon, group/type and remarks, with catalog metadata available as a model card. Directory selection preloads fields and remains editable; available account upstreams and existing custom models remain selectable. A model can be created before a channel exists and before associations are configured.
- Add batch creation and ordinary enable/disable/archive/restore/delete actions. Keep the existing exact channel/upstream bindings and manual-publication semantics. A disabled, archived, unbound or unavailable model is never offered to gateway clients or new Key scopes.
- Gateway Key management adopts the reference's list/search/status presentation and separate create/edit/view/selection dialogs. Selection shows currently usable channels and published models with search, selection summaries and explicit confirmation. Hidden old restrictions remain stored until explicitly removed. Existing Key management authority, admin sessions and encrypted storage are unchanged.
- Keep mobile model editing aligned through shared components and data helpers. New controls must save real existing data fields or validated backward-compatible extensions; do not display unsupported advanced controls.

## Design choices

Adapt the React/TypeScript UI and Rust APIs already in Agent2API. Copying AxonHub's Go/GraphQL services would replace unrelated authentication and routing architecture. Keeping the previous monolithic model form would not match the requested create-then-associate workflow. Shared model components and compatible metadata extensions provide the requested behavior while retaining the installed gateway.

Existing enabled/bindings values remain valid. Optional model metadata and an archived flag extend the record. New standalone model drafts start disabled. Existing model updates retain metadata and associations. Atomic batch requests use the same revision guard as individual writes.

PublicProviderConf remains the fixed directory source. Preserve developer filtering, exact IDs, per-developer associations and global UI deduplication; enrich model metadata without automatically publishing directory entries.

## Constraints

Use F:/axonhub as read-only reference. Preserve F:/Agent2API/data and admin credentials. Stay on local beta at version 3.4.2. No push, version change, tag or Release. Complete isolated tests, rebuild desktop/mobile assets and restart the same local service after the final backend build.
