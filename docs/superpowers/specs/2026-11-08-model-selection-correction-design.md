# AxonHub selection flow correction

The user corrected the preceding implementation: channel creation itself must remain a centered form. Key inspection and per-Key model discovery/selection open an adjacent expandable panel, as implemented in F:/axonhub/frontend/src/features/channels/components/channels-action-dialog.tsx. Preserve drafts, independent groups, fetched candidates, explicit confirmation and custom model entry.

The public model picker must follow AxonHub's developer catalog filtering, avoid reseller duplicates, and deduplicate exact model IDs. It must also allow choosing models fetched from configured upstream accounts and existing custom public models. These sources are selectable in the model editor; selecting a public ID does not silently publish or grant access. Exact upstream IDs and manually typed custom public IDs remain intact.

Upstream bindings list only channels with enabled, credentialed accounts and models allowed by their Key group. Gateway Key candidates list only enabled/usable channels and published models. Hidden existing restrictions must remain stored when unrelated edits are saved, with a separate removable indication; never silently widen a Key's permissions. Disabling a channel/account/group/model immediately removes unavailable model candidates and rejects forwarding.

Keep desktop/mobile model behavior aligned. Preserve user data and existing local service; rebuild and restart it after verification. No version bump, push, tag or Release.

Approach: adapt the existing React/Rust structure, using AxonHub as a read-only behavioral reference. Server filters provide one availability source; shared frontend selectors deduplicate and combine candidates. The prior fullscreen drawer and unfiltered reseller directory are superseded by this correction.
