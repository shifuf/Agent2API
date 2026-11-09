# One routing-group workflow

The user requested removal of Model Management and independent per-model route configuration. Only routing groups should publish public model IDs, select upstream sources and control routing. The user explicitly chose to preserve both conversation and image generation/editing. Prior direct-implementation authorization applies; use the existing beta checkout per repository workflow, preserve version 3.4.2 and credentials, and do not publish these new changes without a new push request.

## Approach

Unify on the existing routing-group engine. Hiding menus alone would leave competing model catalogs; deleting old configuration would break existing clients. Instead, atomically migrate legacy managed models and independent profiles into groups, retaining public IDs, enabled/archived status and effective participation restrictions. Keep the original legacy JSON in a migration backup field. Old administration endpoints must no longer create a second independent catalog; return a clear retired-feature response for writes. Legacy read endpoints may expose compatibility data but cannot advertise additional public entries.

Groups publish chat or image models. A group has `kind: chat | image` (old groups default chat); members and nested groups must match. Image requests use the same group account projection and Key scoping, with image-operation capability checks and the exact selected upstream ID. Image and chat endpoints reject the other kind. Nested groups, disabled accounts/channels/Key groups and gateway Key scopes remain fail-closed.

Public IDs are unique across saved groups, including disabled groups and drafts. An upstream ID alone never reserves a public ID. Automatic found groups remain suggestions unless explicitly enabled. Creating `deepseek-v4.1-flash` with matching upstream members must work.

## User experience

- Desktop and mobile navigation have one route-management entry; old model-page navigation redirects there.
- Creating a route directly creates a routing group; remove the independent/group switch and independent-model rail.
- Keep Magpie styling and colored provider icons, group strategies and request replay. Global gateway protections can remain a settings control, not a second publication workflow.
- Member choices show only enabled, credentialed accounts with a permitted fetched model, grouped by account provider. Chat/image members are distinguished and cannot be mixed.
- Gateway Key choices and `/v1/models` use only available enabled routing groups. Existing unavailable Key restrictions stay stored.
- Models with one upstream use a one-member group. Existing public IDs remain usable after migration.

## Migration and constraints

Migration is idempotent, atomic and runs after legacy configuration/account initialization. Preserve all legacy JSON in a backup field; no account or encryption-key rewrites. Existing groups take precedence on corrupted conflicting input; fail explicitly rather than silently discarding conflicting public IDs. Preserve original public ID casing while matching case-insensitively. No raw source model should become public merely because a profile exists: a profile with no published managed model becomes a disabled group draft.

Legacy profiles transfer strategy, stickiness, provider order and exclusions. Where exclusions require a fixed account set, migrate to explicit selected members using the existing account list, retaining missing IDs for future recovery and never widening access. Simple bindings without exclusions can retain all-account scope. Archived models become disabled groups and keep archived metadata in the backup.

## Validation

Use isolated temporary databases and local mock upstreams. Cover source/public ID collision, duplicate group IDs, migrated aliases and exclusions, restart idempotence, disabled/archived models, image generation and editing with actual upstream IDs, cross-kind rejection and Key scopes. Browser checks cover removed menus, one creation flow, chat/image filtering, source selection, saved group edits and mobile. Build server and frontends, update five translation catalogs and six installation guides when migration instructions change. Existing user data is not test data.
