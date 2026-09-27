import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'

async function availablePort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return port
}

async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited before startup (code ${child.exitCode})`)
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return
    } catch {}
    await delay(100)
  }
  throw new Error('API did not become healthy within 15 seconds')
}

async function request(baseUrl, path, { cookie, ...options } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...options.headers },
  })
  const body = response.status === 204 ? null : await response.json()
  return { response, body }
}

async function login(baseUrl, username, password) {
  const { response, body } = await request(baseUrl, '/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  assert.equal(response.status, 200, body?.error)
  return response.headers.get('set-cookie').split(';', 1)[0]
}

test('inventory adjustment, reservation lifecycle, fulfillment, and role enforcement', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-api-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else { child.once('exit', resolveExit); setTimeout(resolveExit, 3000).unref() }
    })
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const health = await request(baseUrl, '/health')
  assert.equal(health.response.status, 200)
  assert.deepEqual(health.body, { status: 'ok', database: 'connected', storage: 'writable', backups: { local: 'available', remoteConfigured: false }, uptimeSeconds: health.body.uptimeSeconds })
  assert.ok(Number.isInteger(health.body.uptimeSeconds))
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'admin-user', password: 'secure-admin-pass-2026' }) })
  assert.equal(setup.response.status, 201, setup.body?.error)
  const adminCookie = setup.response.headers.get('set-cookie').split(';', 1)[0]
  const createdOperator = await request(baseUrl, '/users', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ username: 'operator-user', password: 'secure-operator-pass-2026', role: 'operator' }) })
  assert.equal(createdOperator.response.status, 201, createdOperator.body?.error)
  const createdViewer = await request(baseUrl, '/users', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ username: 'viewer-user', password: 'secure-viewer-pass-2026', role: 'viewer' }) })
  assert.equal(createdViewer.response.status, 201, createdViewer.body?.error)
  const operatorCookie = await login(baseUrl, 'operator-user', 'secure-operator-pass-2026')
  const viewerCookie = await login(baseUrl, 'viewer-user', 'secure-viewer-pass-2026')

  const createdProduct = await request(baseUrl, '/products', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ sku: 'TF-TEST-001', name: '回归测试商品', price: 12.34, stock: 9 }) })
  assert.equal(createdProduct.response.status, 201, createdProduct.body?.error)
  const openingLedger = await request(baseUrl, '/inventory/ledger?sku=TF-TEST-001', { cookie: adminCookie })
  assert.equal(openingLedger.body[0].type, 'opening')
  assert.equal(openingLedger.body[0].quantityDelta, 9)
  assert.equal(openingLedger.body[0].changedBy, 'admin-user')

  const deniedAdjustment = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie: viewerCookie, body: JSON.stringify({ sku: 'TF-POUCH-006', delta: 1, reason: '盘点补录' }) })
  assert.equal(deniedAdjustment.response.status, 403)
  const missingReason = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ sku: 'TF-POUCH-006', delta: 1, reason: '' }) })
  assert.equal(missingReason.response.status, 400)
  const belowReservation = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ sku: 'TF-POUCH-006', delta: -52, reason: '盘点差异' }) })
  assert.equal(belowReservation.response.status, 409)
  const adjusted = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ sku: 'TF-POUCH-006', delta: 3, reason: '盘点多出三件' }) })
  assert.equal(adjusted.response.status, 200, adjusted.body?.error)
  assert.equal(adjusted.body.stock, 57)
  const ledger = await request(baseUrl, '/inventory/ledger?sku=TF-POUCH-006', { cookie: viewerCookie })
  assert.equal(ledger.body[0].changedBy, 'admin-user')
  assert.equal(ledger.body[0].note, '盘点多出三件')

  const viewerConfirm = await request(baseUrl, '/orders/TF-2026-00824/confirm', { method: 'POST', cookie: viewerCookie })
  assert.equal(viewerConfirm.response.status, 403)
  const confirmed = await request(baseUrl, '/orders/TF-2026-00824/confirm', { method: 'POST', cookie: operatorCookie })
  assert.equal(confirmed.response.status, 200, confirmed.body?.error)
  assert.equal(confirmed.body.status, 'ready')
  assert.equal(confirmed.body.events.at(-1).changedBy, 'operator-user')
  const duplicateConfirm = await request(baseUrl, '/orders/TF-2026-00824/confirm', { method: 'POST', cookie: adminCookie })
  assert.equal(duplicateConfirm.response.status, 409)
  const afterConfirm = await request(baseUrl, '/products', { cookie: adminCookie })
  assert.equal(afterConfirm.body.find(product => product.sku === 'TF-CABLE-003').reserved, 2)

  const cancelled = await request(baseUrl, '/orders/TF-2026-00823/cancel', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ reason: '库存核对演练' }) })
  assert.equal(cancelled.response.status, 200, cancelled.body?.error)
  assert.equal(cancelled.body.events.at(-1).changedBy, 'admin-user')
  const afterCancel = await request(baseUrl, '/products', { cookie: adminCookie })
  assert.equal(afterCancel.body.find(product => product.sku === 'TF-POUCH-006').reserved, 2)
  assert.equal(afterCancel.body.find(product => product.sku === 'TF-TRAVEL-002').reserved, 0)

  const shipped = await request(baseUrl, '/orders/TF-2026-00824/ship', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ carrier: 'Test Carrier', tracking: 'REGRESSION-TRACK-001' }) })
  assert.equal(shipped.response.status, 200, shipped.body?.error)
  assert.equal(shipped.body.events.at(-1).changedBy, 'admin-user')
  const duplicateShip = await request(baseUrl, '/orders/TF-2026-00824/ship', { method: 'POST', cookie: adminCookie, body: JSON.stringify({ carrier: 'Test Carrier', tracking: 'REGRESSION-TRACK-001' }) })
  assert.equal(duplicateShip.response.status, 409)
  const completed = await request(baseUrl, '/orders/TF-2026-00824/complete', { method: 'POST', cookie: adminCookie })
  assert.equal(completed.response.status, 200, completed.body?.error)
  assert.equal(completed.body.status, 'completed')
  assert.equal(completed.body.events.at(-1).changedBy, 'admin-user')
  const finalProducts = await request(baseUrl, '/products', { cookie: adminCookie })
  assert.equal(finalProducts.body.find(product => product.sku === 'TF-CABLE-003').stock, 126)
  assert.equal(finalProducts.body.find(product => product.sku === 'TF-CABLE-003').reserved, 0)

  const integrityOrder = await request(baseUrl, '/orders/demo', { method: 'POST', cookie: adminCookie })
  assert.equal(integrityOrder.response.status, 201, integrityOrder.body?.error)
  const confirmedForIntegrity = await request(baseUrl, `/orders/${encodeURIComponent(integrityOrder.body.id)}/confirm`, { method: 'POST', cookie: adminCookie })
  assert.equal(confirmedForIntegrity.response.status, 200, confirmedForIntegrity.body?.error)
  const damageSku = integrityOrder.body.items[0].sku
  const damageSimulation = spawn(process.execPath, ['-e', `import Database from 'better-sqlite3'; const db=new Database(${JSON.stringify(resolve(dataDir,'tradeflow.sqlite'))}); db.prepare('DELETE FROM order_inventory WHERE order_id=? AND sku=?').run(${JSON.stringify(integrityOrder.body.id)},${JSON.stringify(damageSku)}); db.close()`], { cwd: resolve(import.meta.dirname, '..'), stdio: 'ignore' })
  await new Promise((resolveExit, reject) => { damageSimulation.once('error', reject); damageSimulation.once('exit', code => code === 0 ? resolveExit() : reject(new Error(`damage simulation exited ${code}`))) })
  const incompleteHoldShip = await request(baseUrl, `/orders/${encodeURIComponent(integrityOrder.body.id)}/ship`, { method: 'POST', cookie: adminCookie, body: JSON.stringify({ carrier: 'Test Carrier', tracking: 'REGRESSION-TRACK-INCOMPLETE' }) })
  assert.equal(incompleteHoldShip.response.status, 409)
  assert.match(incompleteHoldShip.body.error, /预占记录不完整/)
  const intactAfterIncompleteShip = await request(baseUrl, '/products', { cookie: adminCookie })
  const damagedProduct = intactAfterIncompleteShip.body.find(product => product.sku === damageSku)
  const beforeIntegrityTest = finalProducts.body.find(product => product.sku === damageSku)
  assert.equal(damagedProduct.stock, beforeIntegrityTest.stock)
  assert.equal(damagedProduct.reserved, beforeIntegrityTest.reserved + integrityOrder.body.items.find(item => item.sku === damageSku).qty)

  const changedRole = await request(baseUrl, `/users/${createdViewer.body.id}`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ role: 'operator' }) })
  assert.equal(changedRole.response.status, 200, changedRole.body?.error)
  assert.equal(changedRole.body.role, 'operator')
  const disabled = await request(baseUrl, `/users/${createdViewer.body.id}`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ active: false }) })
  assert.equal(disabled.response.status, 200, disabled.body?.error)
  const revokedViewer = await request(baseUrl, '/inventory/ledger', { cookie: viewerCookie })
  assert.equal(revokedViewer.response.status, 401)
  const reenabled = await request(baseUrl, `/users/${createdViewer.body.id}`, { method: 'PATCH', cookie: adminCookie, body: JSON.stringify({ active: true }) })
  assert.equal(reenabled.response.status, 200, reenabled.body?.error)
  const userAudit = await request(baseUrl, '/users/audit', { cookie: adminCookie })
  assert.deepEqual(userAudit.body.slice(0, 3).map(event => event.type), ['enabled', 'disabled', 'role_changed'])
  assert.ok(userAudit.body.slice(0, 3).every(event => event.actor === 'admin-user' && event.target === 'viewer-user'))
})

test('existing SQLite databases gain audit columns without losing data or sessions', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-migration-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const startServer = () => spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore',
  })
  let child = startServer()
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise(resolveExit => child.once('exit', resolveExit))
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'migration-admin', password: 'migration-admin-pass-2026' }) })
  assert.equal(setup.response.status, 201, setup.body?.error)
  const cookie = setup.response.headers.get('set-cookie').split(';', 1)[0]
  const created = await request(baseUrl, '/products', { method: 'POST', cookie, body: JSON.stringify({ sku: 'TF-MIGRATE-001', name: '升级保留商品', price: 8.5, stock: 12 }) })
  assert.equal(created.response.status, 201, created.body?.error)

  child.kill()
  await new Promise(resolveExit => child.exitCode !== null ? resolveExit() : child.once('exit', resolveExit))
  const previousSchema = new Database(resolve(dataDir, 'tradeflow.sqlite'))
  previousSchema.exec('ALTER TABLE inventory_ledger DROP COLUMN changed_by; ALTER TABLE order_events DROP COLUMN changed_by;')
  previousSchema.close()

  child = startServer()
  await waitForHealth(baseUrl, child)
  const session = await request(baseUrl, '/auth/me', { cookie })
  assert.equal(session.response.status, 200)
  const preservedProduct = await request(baseUrl, '/products', { cookie })
  assert.equal(preservedProduct.body.find(product => product.sku === 'TF-MIGRATE-001')?.stock, 12)
  const adjusted = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie, body: JSON.stringify({ sku: 'TF-MIGRATE-001', delta: 2, reason: '升级后入库核对' }) })
  assert.equal(adjusted.response.status, 200, adjusted.body?.error)
  const ledger = await request(baseUrl, '/inventory/ledger?sku=TF-MIGRATE-001', { cookie })
  assert.equal(ledger.body[0].changedBy, 'migration-admin')
})

test('restoring a pre-audit backup migrates schema, retains snapshot data, and revokes sessions', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-restore-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test' },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else { child.once('exit', resolveExit); setTimeout(resolveExit, 3000).unref() }
    })
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'restore-admin', password: 'restore-admin-pass-2026' }) })
  assert.equal(setup.response.status, 201, setup.body?.error)
  const oldCookie = setup.response.headers.get('set-cookie').split(';', 1)[0]
  const before = await request(baseUrl, '/products', { method: 'POST', cookie: oldCookie, body: JSON.stringify({ sku: 'TF-RESTORE-001', name: '快照保留商品', price: 5, stock: 4 }) })
  assert.equal(before.response.status, 201)
  const snapshot = await request(baseUrl, '/backups', { method: 'POST', cookie: oldCookie })
  assert.equal(snapshot.response.status, 201, snapshot.body?.error)

  const snapshotDb = new Database(resolve(dataDir, 'backups', snapshot.body.name))
  snapshotDb.exec('ALTER TABLE inventory_ledger DROP COLUMN changed_by; ALTER TABLE order_events DROP COLUMN changed_by;')
  snapshotDb.close()
  const after = await request(baseUrl, '/products', { method: 'POST', cookie: oldCookie, body: JSON.stringify({ sku: 'TF-RESTORE-002', name: '快照之后商品', price: 9, stock: 7 }) })
  assert.equal(after.response.status, 201)

  const restored = await request(baseUrl, `/backups/${encodeURIComponent(snapshot.body.name)}/restore`, { method: 'POST', cookie: oldCookie, body: JSON.stringify({ confirmation: 'RESTORE' }) })
  assert.equal(restored.response.status, 200, restored.body?.error)
  assert.equal(restored.body.status, 'restored')
  assert.equal((await request(baseUrl, '/auth/me', { cookie: oldCookie })).response.status, 401)
  const newCookie = await login(baseUrl, 'restore-admin', 'restore-admin-pass-2026')
  const products = await request(baseUrl, '/products', { cookie: newCookie })
  assert.equal(products.body.find(product => product.sku === 'TF-RESTORE-001')?.stock, 4)
  assert.equal(products.body.some(product => product.sku === 'TF-RESTORE-002'), false)
  const adjusted = await request(baseUrl, '/inventory/adjustments', { method: 'POST', cookie: newCookie, body: JSON.stringify({ sku: 'TF-RESTORE-001', delta: 1, reason: '恢复后验证迁移' }) })
  assert.equal(adjusted.response.status, 200, adjusted.body?.error)
  const ledger = await request(baseUrl, '/inventory/ledger?sku=TF-RESTORE-001', { cookie: newCookie })
  assert.equal(ledger.body[0].changedBy, 'restore-admin')
})

test('failed OSS uploads remain visible and can be retried successfully', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-oss-retry-'))
  const objects = new Map()
  let acceptPuts = false
  const objectServer = createHttpServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method === 'PUT') {
      const key = url.pathname.split('/').filter(Boolean).slice(1).join('/')
      if (!acceptPuts) {
        req.resume()
        res.writeHead(503, { 'content-type': 'application/xml' }).end('<Error><Code>ServiceUnavailable</Code><Message>retry later</Message></Error>')
        return
      }
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks))
        res.writeHead(200, { ETag: '"mock-etag"' }).end()
      })
      return
    }
    if (req.method === 'GET' && url.searchParams.has('list-type')) {
      const prefix = url.searchParams.get('prefix') || ''
      const entries = [...objects].filter(([key]) => key.startsWith(prefix))
      const content = entries.map(([key, body]) => `<Contents><Key>${key}</Key><LastModified>2026-09-26T12:00:00.000Z</LastModified><ETag>"mock-etag"</ETag><Size>${body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('')
      res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>mock-bucket</Name><Prefix>${prefix}</Prefix><KeyCount>${entries.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${content}</ListBucketResult>`)
      return
    }
    req.resume()
    res.writeHead(404).end()
  })
  await new Promise((resolveListen, reject) => objectServer.once('error', reject).listen(0, '127.0.0.1', resolveListen))
  const objectPort = objectServer.address().port
  const apiPort = await availablePort()
  const baseUrl = `http://127.0.0.1:${apiPort}`
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '1',
      BACKUP_S3_BUCKET: 'mock-bucket',
      BACKUP_S3_REGION: 'us-east-1',
      BACKUP_S3_ENDPOINT: `http://127.0.0.1:${objectPort}`,
      BACKUP_S3_FORCE_PATH_STYLE: 'true',
      BACKUP_S3_ACCESS_KEY_ID: 'mock-access-key',
      BACKUP_S3_SECRET_ACCESS_KEY: 'mock-secret-key',
    },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else { child.once('exit', resolveExit); setTimeout(resolveExit, 3000).unref() }
    })
    await new Promise(resolveClose => objectServer.close(resolveClose))
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'oss-admin', password: 'oss-admin-pass-2026' }) })
  assert.equal(setup.response.status, 201, setup.body?.error)
  const cookie = setup.response.headers.get('set-cookie').split(';', 1)[0]
  const forwardedAddress = '198.51.100.42'
  for (let attempt = 0; attempt < 10; attempt++) {
    const failedLogin = await request(baseUrl, '/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': forwardedAddress }, body: JSON.stringify({ username: 'nobody', password: 'incorrect-password' }) })
    assert.equal(failedLogin.response.status, 401)
  }
  const throttledLogin = await request(baseUrl, '/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': forwardedAddress }, body: JSON.stringify({ username: 'nobody', password: 'incorrect-password' }) })
  assert.equal(throttledLogin.response.status, 429)
  const separateClient = await request(baseUrl, '/auth/login', { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.74' }, body: JSON.stringify({ username: 'nobody', password: 'incorrect-password' }) })
  assert.equal(separateClient.response.status, 401)
  const viewer = await request(baseUrl, '/users', { method: 'POST', cookie, body: JSON.stringify({ username: 'oss-viewer', password: 'oss-viewer-pass-2026', role: 'viewer' }) })
  assert.equal(viewer.response.status, 201)
  const viewerCookie = await login(baseUrl, 'oss-viewer', 'oss-viewer-pass-2026')
  const created = await request(baseUrl, '/backups', { method: 'POST', cookie })
  assert.equal(created.response.status, 201, created.body?.error)
  assert.equal(created.body.remoteUploaded, false)

  const statusBeforeRetry = await request(baseUrl, '/backups/status', { cookie })
  assert.ok(statusBeforeRetry.body.pendingRemoteCount >= 1)
  acceptPuts = true
  const deniedRetry = await request(baseUrl, '/backups/retry-remote', { method: 'POST', cookie: viewerCookie })
  assert.equal(deniedRetry.response.status, 403)
  const retry = await request(baseUrl, '/backups/retry-remote', { method: 'POST', cookie })
  assert.equal(retry.response.status, 200, retry.body?.error)
  assert.equal(retry.body.failed, 0)
  assert.ok(retry.body.uploaded >= 1)
  const statusAfterRetry = await request(baseUrl, '/backups/status', { cookie })
  assert.equal(statusAfterRetry.body.pendingRemoteCount, 0)
  const remote = await request(baseUrl, '/backups/remote', { cookie })
  assert.ok(remote.body.backups.some(backup => backup.name === created.body.name))
})

test('production admin initialization requires a deployment token and is single-use', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-production-setup-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const setupToken = 'test-bootstrap-secret-token-long-enough-2026'
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', TRADEFLOW_SETUP_TOKEN: setupToken, TRADEFLOW_SEED_DEMO_DATA: 'false' },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else { child.once('exit', resolveExit); setTimeout(resolveExit, 3000).unref() }
    })
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const status = await request(baseUrl, '/auth/setup-status')
  assert.deepEqual(status.body, { setupRequired: true, setupTokenRequired: true, setupBlocked: false })
  const withoutToken = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'production-admin', password: 'production-admin-pass-2026' }) })
  assert.equal(withoutToken.response.status, 403)
  const wrongToken = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'production-admin', password: 'production-admin-pass-2026', setupToken: 'wrong-token' }) })
  assert.equal(wrongToken.response.status, 403)
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'production-admin', password: 'production-admin-pass-2026', setupToken }) })
  assert.equal(setup.response.status, 201, setup.body?.error)
  assert.ok(setup.response.headers.get('set-cookie').includes('Secure'))
  const productionCookie = setup.response.headers.get('set-cookie').split(';', 1)[0]
  const productionProducts = await request(baseUrl, '/products', { cookie: productionCookie })
  const productionOrders = await request(baseUrl, '/orders', { cookie: productionCookie })
  assert.deepEqual(productionProducts.body, [])
  assert.deepEqual(productionOrders.body, [])
  const completedStatus = await request(baseUrl, '/auth/setup-status')
  assert.deepEqual(completedStatus.body, { setupRequired: false, setupTokenRequired: false, setupBlocked: false })
  const secondSetup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'another-admin', password: 'another-admin-pass-2026', setupToken }) })
  assert.equal(secondSetup.response.status, 409)
})

test('production refuses first-admin setup when no deployment token is configured', async t => {
  const dataDir = await mkdtemp(resolve(tmpdir(), 'tradeflow-production-blocked-'))
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production', TRADEFLOW_SETUP_TOKEN: '', TRADEFLOW_SEED_DEMO_DATA: 'false' },
    stdio: 'ignore',
  })
  t.after(async () => {
    child.kill()
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else { child.once('exit', resolveExit); setTimeout(resolveExit, 3000).unref() }
    })
    await rm(dataDir, { recursive: true, force: true })
  })

  await waitForHealth(baseUrl, child)
  const status = await request(baseUrl, '/auth/setup-status')
  assert.deepEqual(status.body, { setupRequired: true, setupTokenRequired: true, setupBlocked: true })
  const setup = await request(baseUrl, '/auth/setup', { method: 'POST', body: JSON.stringify({ username: 'blocked-admin', password: 'blocked-admin-pass-2026' }) })
  assert.equal(setup.response.status, 503)
})
