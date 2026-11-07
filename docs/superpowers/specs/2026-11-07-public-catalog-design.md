# Public model catalog and channel drawer

User requested direct implementation: preload the PublicProviderConf all.json used by AxonHub so model IDs can be selected by manufacturer, and present channel creation in a left drawer. This extends the approved gateway-wide manual model management.

- Fetch the fixed HTTPS catalog through the gateway. Normalize provider/model IDs and names, cache successful results in memory and on disk, refresh after one hour and on explicit request, and retain usable cached data on failures. No API credentials are sent to the catalog host. Bound response size/time and concurrent fetches.
- Desktop and mobile model editors preload candidates, offer manufacturer selection and model search, and fill public ID/name when selected. Custom IDs remain possible. Selecting a candidate never publishes it or silently grants channel access; users still explicitly select existing channel/upstream bindings and save.
- API-template channel forms use a left sheet, with visible sections for channel details and Key groups. Existing account flows and credential drafts retain their behavior. Channel model choices remain specific to the selected Key.
- Retain the current Rust/React architecture and translation conventions. Keep local beta, version 3.4.2, no push/tag/release. Keep user data at F:/Agent2API/data; validate against isolated fixtures, then restart the existing local service on 127.0.0.1:3065 with the new build.

Implementation choice: server caching avoids repeated multi-megabyte browser downloads and supports stale results during outages. A browser-only fetch has no shared persistent cache; a build-only snapshot cannot provide current IDs. Preserve the explicit catalog behavior introduced earlier.
