// Workflow tests exercise real local APIs; public release availability is unrelated.
// Keep the server's response and permissions, quiet only its optional update notice.
export async function isolateUpdateNotice(context) {
  await context.route('**/api/update/status*', async route => {
    const response = await route.fetch()
    if (!response.ok()) { await route.fulfill({ response }); return }
    const value = await response.json()
    const info = value?.success === true ? value.data : value
    if (info && typeof info === 'object') info.hasUpdate = false
    await route.fulfill({ response, json: value })
  })
}
