import 'dotenv/config'
import express from 'express'
import Database from 'better-sqlite3'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import AlibabaCredential from '@alicloud/credentials'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'))
const backupDir = resolve(dataDir, 'backups')
mkdirSync(dataDir, { recursive: true })
mkdirSync(backupDir, { recursive: true })
const backupBucket=process.env.BACKUP_S3_BUCKET||''
const backupPrefix=(process.env.BACKUP_S3_PREFIX||'tradeflow').replace(/^\/+|\/+$/g,'')
const useEcsRamRole=process.env.BACKUP_S3_CREDENTIAL_MODE==='ecs_ram_role'
const backupS3Endpoint=process.env.BACKUP_S3_ENDPOINT||''
const hasStaticBackupCredentials=Boolean(process.env.BACKUP_S3_ACCESS_KEY_ID&&process.env.BACKUP_S3_SECRET_ACCESS_KEY)
const backupRemoteConfigIssue=!backupBucket?null:useEcsRamRole&&!backupS3Endpoint?'ECS RAM 角色模式还需要配置 OSS S3 Endpoint；备份目前只保存在本机':!useEcsRamRole&&!hasStaticBackupCredentials?'已填写 OSS Bucket，但未配置 ECS RAM 角色或完整的 AccessKey 凭据；备份目前只保存在本机':null
const canConfigureRemoteBackup=Boolean(backupBucket&&!backupRemoteConfigIssue)
const aliCredentialClient=backupBucket&&useEcsRamRole?new AlibabaCredential.default(new AlibabaCredential.Config({
  type:'ecs_ram_role',
  roleName:process.env.BACKUP_S3_RAM_ROLE_NAME||undefined,
  disableIMDSv1:true,
})):null
const s3Client=canConfigureRemoteBackup?new S3Client({
  region:process.env.BACKUP_S3_REGION||'us-east-1',
  endpoint:backupS3Endpoint||undefined,
  forcePathStyle:process.env.BACKUP_S3_FORCE_PATH_STYLE==='true',
  requestChecksumCalculation:'WHEN_REQUIRED',
  credentials:aliCredentialClient?async()=>{
    const credential=await aliCredentialClient.getCredential()
    return {
      accessKeyId:credential.accessKeyId,
      secretAccessKey:credential.accessKeySecret,
      sessionToken:credential.securityToken,
      // The Alibaba provider refreshes its own token; this asks the AWS SDK to re-read it periodically.
      expiration:new Date(Date.now()+10*60*1000),
    }
  }:process.env.BACKUP_S3_ACCESS_KEY_ID&&process.env.BACKUP_S3_SECRET_ACCESS_KEY?{
    accessKeyId:process.env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey:process.env.BACKUP_S3_SECRET_ACCESS_KEY,
    sessionToken:process.env.BACKUP_S3_SESSION_TOKEN||undefined,
  }:undefined,
}):null
const dbPath = resolve(dataDir, 'tradeflow.sqlite')
let db = new Database(dbPath)
let restoreInProgress=false
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
const schemaSql = `
  CREATE TABLE IF NOT EXISTS products (
    sku TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '其他',
    description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
    stock INTEGER NOT NULL CHECK(stock >= 0), reserved_stock INTEGER NOT NULL DEFAULT 0 CHECK(reserved_stock >= 0), threshold INTEGER NOT NULL DEFAULT 8,
    active INTEGER NOT NULL DEFAULT 1, theme TEXT NOT NULL DEFAULT 'thumb-blue', icon TEXT NOT NULL DEFAULT 'Package'
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, country TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('processing','ready','shipped','completed','cancelled')),
    subtotal_cents INTEGER NOT NULL, shipping_cents INTEGER NOT NULL, total_cents INTEGER NOT NULL,
    carrier TEXT, tracking TEXT, inventory_deducted INTEGER NOT NULL DEFAULT 0,
    cancel_reason TEXT, shipped_at TEXT, completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    sku TEXT NOT NULL, product_name TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty > 0), unit_price_cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_inventory (
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    sku TEXT NOT NULL REFERENCES products(sku), qty INTEGER NOT NULL CHECK(qty > 0),
    state TEXT NOT NULL CHECK(state IN ('reserved','consumed','released')),
    PRIMARY KEY(order_id,sku)
  );
  CREATE TABLE IF NOT EXISTS inventory_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL REFERENCES products(sku),
    order_id TEXT, event_type TEXT NOT NULL, quantity_delta INTEGER NOT NULL,
    reserved_delta INTEGER NOT NULL, stock_after INTEGER NOT NULL, reserved_after INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', changed_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL, target_username TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('created','role_changed','disabled','enabled')),
    old_role TEXT, new_role TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS user_audit_events_created_idx ON user_audit_events(id DESC);
  CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
`
const addColumn = (table, column, definition) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
function applySchemaMigrations(){
  db.exec(schemaSql)
  addColumn('orders', 'cancel_reason', 'TEXT')
  addColumn('orders', 'shipped_at', 'TEXT')
  addColumn('orders', 'completed_at', 'TEXT')
  addColumn('products', 'reserved_stock', 'INTEGER NOT NULL DEFAULT 0 CHECK(reserved_stock >= 0)')
  addColumn('inventory_ledger', 'changed_by', 'INTEGER REFERENCES users(id)')
  addColumn('order_events', 'changed_by', 'INTEGER REFERENCES users(id)')
}
applySchemaMigrations()
const seedDemoData=process.env.TRADEFLOW_SEED_DEMO_DATA===undefined?process.env.NODE_ENV!=='production':process.env.TRADEFLOW_SEED_DEMO_DATA==='true'
const productSeeds = [
  ['TF-DESK-001','极简桌面收纳架','家居收纳','简约实用的桌面收纳架，适合整理文具与日常小物。虚构商品，仅用于演示。',2890,42,'thumb-blue','BriefcaseBusiness',1],
  ['TF-TRAVEL-002','轻量旅行收纳袋','旅行配件','轻便耐用的旅行收纳袋，让行李收纳更轻松。虚构商品，仅用于演示。',1950,6,'thumb-peach','Package',1],
  ['TF-CABLE-003','编织 USB-C 充电线','数码配件','结实耐用的编织充电线，适用于常见 USB-C 设备。虚构商品，仅用于演示。',1299,128,'thumb-lilac','Activity',1],
  ['TF-BOTTLE-004','随行保温水杯','户外生活','轻巧随行的保温水杯，适合通勤与户外活动。虚构商品，仅用于演示。',2400,31,'thumb-mint','Globe2',1],
  ['TF-LAMP-005','柔光 LED 阅读灯','家居照明','小巧的桌面阅读灯，提供舒适柔和的阅读光线。虚构商品，仅用于演示。',3580,0,'thumb-yellow','Lightbulb',0],
  ['TF-POUCH-006','数码配件整理包','数码配件','为充电器、线材等数码配件设计的便携整理包。虚构商品，仅用于演示。',1675,54,'thumb-rose','PackageCheck',1],
]
if (seedDemoData && db.prepare('SELECT COUNT(*) AS count FROM products').get().count === 0) {
  const insert = db.prepare('INSERT INTO products (sku,name,category,description,price_cents,stock,threshold,active,theme,icon) VALUES (?,?,?,?,?,?,8,?,?,?)')
  const seedProducts = db.transaction(() => productSeeds.forEach(([sku,name,category,description,price,stock,theme,icon,active]) => insert.run(sku,name,category,description,price,stock,active,theme,icon)))
  seedProducts()
}
if (seedDemoData && db.prepare('SELECT COUNT(*) AS count FROM orders').get().count === 0) {
  const orderSeeds = [
    {id:'TF-2026-00824',date:'2026-09-26T09:42:00',country:'美国',status:'processing',items:[['TF-DESK-001',1,2890],['TF-CABLE-003',2,1299]],shipping:500},
    {id:'TF-2026-00823',date:'2026-09-26T08:18:00',country:'加拿大',status:'ready',items:[['TF-TRAVEL-002',1,1950],['TF-POUCH-006',1,1675]],shipping:650},
    {id:'TF-2026-00822',date:'2026-09-25T22:05:00',country:'英国',status:'shipped',items:[['TF-BOTTLE-004',1,2400]],shipping:480,carrier:'Demo Express',tracking:'DEMO-2026-000822',deducted:true},
    {id:'TF-2026-00821',date:'2026-09-25T19:36:00',country:'澳大利亚',status:'completed',items:[['TF-CABLE-003',2,1299]],shipping:720},
    {id:'TF-2026-00820',date:'2026-09-25T16:20:00',country:'德国',status:'processing',items:[['TF-LAMP-005',1,3580]],shipping:750},
    {id:'TF-2026-00819',date:'2026-09-25T13:12:00',country:'日本',status:'cancelled',items:[['TF-DESK-001',1,2890]],shipping:800},
    {id:'TF-2026-00818',date:'2026-09-24T20:47:00',country:'法国',status:'ready',items:[['TF-POUCH-006',2,1675]],shipping:700},
    {id:'TF-2026-00817',date:'2026-09-24T11:26:00',country:'美国',status:'shipped',items:[['TF-TRAVEL-002',1,1950]],shipping:500,carrier:'Sample Logistics',tracking:'SAMPLE-000817',deducted:true},
  ]
  const seedOrders = db.transaction(() => {
    for (const order of orderSeeds) {
      const subtotal = order.items.reduce((sum, item) => sum + item[1] * item[2], 0)
      db.prepare('INSERT INTO orders (id,created_at,country,status,subtotal_cents,shipping_cents,total_cents,carrier,tracking,inventory_deducted) VALUES (?,?,?,?,?,?,?,?,?,?)').run(order.id,order.date,order.country,order.status,subtotal,order.shipping,subtotal+order.shipping,order.carrier||null,order.tracking||null,order.deducted?1:0)
      const addItem = db.prepare('INSERT INTO order_items (order_id,sku,product_name,qty,unit_price_cents) VALUES (?,?,?,?,?)')
      for (const [sku,qty,price] of order.items) addItem.run(order.id,sku,db.prepare('SELECT name FROM products WHERE sku=?').get(sku).name,qty,price)
    }
    // Seeded shipped orders already had their inventory movement reflected in the initial snapshot.
    db.prepare('UPDATE products SET stock=stock-1 WHERE sku=?').run('TF-BOTTLE-004')
    db.prepare('UPDATE products SET stock=stock-1 WHERE sku=?').run('TF-TRAVEL-002')
  })
  seedOrders()
}

// Bring older local databases into the reservation and audit-ledger model without resetting data.
function applyBusinessMigrations(){
  if (db.prepare('SELECT COUNT(*) AS count FROM inventory_ledger').get().count === 0) {
    const recordOpening = db.prepare("INSERT INTO inventory_ledger (sku,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,created_at) VALUES (?,'opening',?,0,?,0,'升级时的库存期初快照',?)")
    const timestamp = new Date().toISOString()
    for (const product of db.prepare('SELECT sku,stock FROM products').all()) recordOpening.run(product.sku,product.stock,product.stock,timestamp)
  }
  const legacyReady = db.prepare("SELECT * FROM orders WHERE status='ready' AND NOT EXISTS (SELECT 1 FROM order_inventory WHERE order_id=orders.id)").all()
  for (const order of legacyReady) {
    try {
      db.transaction(() => {
        for (const item of db.prepare('SELECT sku,product_name,SUM(qty) AS qty FROM order_items WHERE order_id=? GROUP BY sku,product_name').all(order.id)) {
          const product = db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(item.sku)
          if (!product || product.stock-product.reserved_stock < item.qty) throw new Error(`${item.product_name} 可用库存不足，不能安全预占`)
          db.prepare('UPDATE products SET reserved_stock=reserved_stock+? WHERE sku=?').run(item.qty,item.sku)
          db.prepare("INSERT INTO order_inventory (order_id,sku,qty,state) VALUES (?,?,?,'reserved')").run(order.id,item.sku,item.qty)
          const after=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(item.sku)
          db.prepare("INSERT INTO inventory_ledger (sku,order_id,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,created_at) VALUES (?,?, 'reserve',0,?,?,?,?,?)").run(item.sku,order.id,item.qty,after.stock,after.reserved_stock,'兼容升级：为既有待发货订单预占库存',new Date().toISOString())
        }
      })()
    } catch (error) {
      if (!db.prepare("SELECT 1 FROM order_events WHERE order_id=? AND event_type='inventory_review'").get(order.id)) {
        db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,reason,created_at) VALUES(?,'inventory_review','ready','ready',?,?)").run(order.id,error.message,new Date().toISOString())
      }
      console.warn(`Inventory review required for ${order.id}: ${error.message}`)
    }
  }
}
applyBusinessMigrations()

const app = express()
const trustProxyHops=process.env.TRUST_PROXY_HOPS===undefined?0:Number(process.env.TRUST_PROXY_HOPS)
if(!Number.isInteger(trustProxyHops)||trustProxyHops<0||trustProxyHops>1)throw new Error('TRUST_PROXY_HOPS must be 0 or 1; only the single configured Caddy proxy may be trusted.')
app.set('trust proxy',trustProxyHops)
app.use(express.json({ limit: '100kb' }))
const sessionCookie = 'tradeflow_session'
const roleNames = { admin:'管理员', operator:'运营', viewer:'只读' }
const bootstrapSetupToken=process.env.TRADEFLOW_SETUP_TOKEN||''
const hashToken = token => createHash('sha256').update(token).digest('hex')
const passwordHash = password => {
  const salt=randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`
}
const verifyPassword = (password, stored) => {
  const [salt,key]=String(stored||'').split(':')
  if(!salt||!key)return false
  const expected=Buffer.from(key,'hex'), actual=scryptSync(password,salt,64)
  return expected.length===actual.length&&timingSafeEqual(expected,actual)
}
const userDto = user => ({id:user.id,username:user.username,role:user.role,roleName:roleNames[user.role],active:Boolean(user.active),createdAt:user.created_at})
app.use((req,_res,next)=>{
  const token=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length+1)
  if(token){
    const session=db.prepare('SELECT user_id,expires_at FROM auth_sessions WHERE token_hash=?').get(hashToken(decodeURIComponent(token)))
    if(session&&session.expires_at>Date.now()){
      const user=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(session.user_id)
      if(user)req.authUser=user
    }
  }
  next()
})
const loginFailures=new Map()
const makeSession=(res,user)=>{
  const token=randomBytes(32).toString('base64url'), now=Date.now(), expires=new Date(now+12*60*60*1000)
  db.prepare('INSERT INTO auth_sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(hashToken(token),user.id,String(expires.getTime()),new Date(now).toISOString())
  const secure=process.env.NODE_ENV==='production'?'; Secure':''
  res.setHeader('Set-Cookie',`${sessionCookie}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`)
}
const clearSession=res=>res.setHeader('Set-Cookie',`${sessionCookie}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`)
const requireRoles=(...roles)=>(req,res,next)=>roles.includes(req.authUser?.role)?next():res.status(req.authUser?403:401).json({error:req.authUser?'当前账号没有执行此操作的权限':'请先登录'})
const requireAdmin=requireRoles('admin')
app.get('/api/auth/setup-status',(_req,res)=>{
  const setupRequired=db.prepare('SELECT COUNT(*) AS count FROM users').get().count===0
  const setupTokenRequired=setupRequired&&(process.env.NODE_ENV==='production'||Boolean(bootstrapSetupToken))
  const setupBlocked=setupRequired&&process.env.NODE_ENV==='production'&&!bootstrapSetupToken
  res.json({setupRequired,setupTokenRequired,setupBlocked})
})
app.post('/api/auth/setup',(req,res)=>{
  if(db.prepare('SELECT COUNT(*) AS count FROM users').get().count!==0)return res.status(409).json({error:'管理员已初始化，请使用登录'} )
  if(process.env.NODE_ENV==='production'&&!bootstrapSetupToken)return res.status(503).json({error:'生产环境尚未配置管理员初始化口令，请先在服务器 .env 设置 TRADEFLOW_SETUP_TOKEN'})
  if(bootstrapSetupToken){
    const supplied=Buffer.from(String(req.body?.setupToken||''),'utf8'),expected=Buffer.from(bootstrapSetupToken,'utf8')
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return res.status(403).json({error:'管理员初始化口令不正确'})
  }
  const username=String(req.body?.username||'').trim(), password=String(req.body?.password||'')
  if(!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username))return res.status(400).json({error:'用户名需为 3 到 32 位字母、数字或 . _ -'})
  if(password.length<12||password.length>128)return res.status(400).json({error:'管理员密码长度需为 12 到 128 位'})
  const result=db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,'admin',?)").run(username,passwordHash(password),new Date().toISOString())
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid)
  makeSession(res,user);res.status(201).json(userDto(user))
})
app.post('/api/auth/login',(req,res)=>{
  const ip=req.ip||'unknown', now=Date.now(), failures=(loginFailures.get(ip)||[]).filter(time=>now-time<15*60*1000)
  if(failures.length>=10)return res.status(429).json({error:'登录尝试次数过多，请 15 分钟后再试'})
  const username=String(req.body?.username||'').trim(), password=String(req.body?.password||'')
  const user=db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username)
  if(!user||!verifyPassword(password,user.password_hash)){failures.push(now);loginFailures.set(ip,failures);return res.status(401).json({error:'用户名或密码不正确'})}
  loginFailures.delete(ip);makeSession(res,user);res.json(userDto(user))
})
app.get('/api/auth/me',(req,res)=>req.authUser?res.json(userDto(req.authUser)):res.status(401).json({error:'尚未登录'}))
app.post('/api/auth/logout',(req,res)=>{
  const token=String(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length+1)
  if(token)db.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(hashToken(decodeURIComponent(token)))
  clearSession(res);res.status(204).end()
})
app.use('/api', (req,res,next)=>{
  if(req.path==='/health')return next()
  if(restoreInProgress)return res.status(503).json({error:'数据库正在恢复，请稍后重试'})
  if(req.path.startsWith('/auth/'))return next()
  if(req.authUser)return next()
  res.status(401).json({error:'请先登录'})
})
app.get('/api/users',requireAdmin,(_req,res)=>res.json(db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(userDto)))
app.get('/api/users/audit',requireAdmin,(_req,res)=>res.json(db.prepare('SELECT id,actor_username AS actor,target_username AS target,event_type AS type,old_role AS oldRole,new_role AS newRole,created_at AS date FROM user_audit_events ORDER BY id DESC LIMIT 200').all()))
app.post('/api/users',requireAdmin,(req,res)=>{
  const username=String(req.body?.username||'').trim(),password=String(req.body?.password||''),role=String(req.body?.role||'')
  if(!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username))return res.status(400).json({error:'用户名需为 3 到 32 位字母、数字或 . _ -'})
  if(password.length<12||password.length>128)return res.status(400).json({error:'密码长度需为 12 到 128 位'})
  if(!['admin','operator','viewer'].includes(role))return res.status(400).json({error:'请选择有效的角色'})
  try{const created=db.transaction(()=>{const now=new Date().toISOString(),result=db.prepare('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)').run(username,passwordHash(password),role,now),userId=result.lastInsertRowid;db.prepare("INSERT INTO user_audit_events(actor_user_id,target_user_id,actor_username,target_username,event_type,new_role,created_at) VALUES(?,?,?,?, 'created',?,?)").run(req.authUser.id,userId,req.authUser.username,username,role,now);return db.prepare('SELECT * FROM users WHERE id=?').get(userId)})();res.status(201).json(userDto(created))}catch(error){if(error.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'用户名已存在'});throw error}
})
app.patch('/api/users/:id',requireAdmin,(req,res)=>{
  const user=db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id))
  if(!user)return res.status(404).json({error:'未找到该用户'})
  const role=req.body?.role===undefined?user.role:String(req.body.role), active=req.body?.active===undefined?Boolean(user.active):Boolean(req.body.active)
  if(!['admin','operator','viewer'].includes(role))return res.status(400).json({error:'请选择有效的角色'})
  if(user.id===req.authUser.id&&(!active||role!=='admin'))return res.status(400).json({error:'不能停用或降级当前登录的管理员'})
  if(user.role==='admin'&&user.active&&(!active||role!=='admin')&&db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND active=1").get().count<2)return res.status(409).json({error:'系统至少需要保留一位启用的管理员'})
  const changedRole=role!==user.role,changedActive=active!==Boolean(user.active),now=new Date().toISOString()
  db.transaction(()=>{
    db.prepare('UPDATE users SET role=?,active=? WHERE id=?').run(role,active?1:0,user.id)
    const addEvent=db.prepare('INSERT INTO user_audit_events(actor_user_id,target_user_id,actor_username,target_username,event_type,old_role,new_role,created_at) VALUES(?,?,?,?,?,?,?,?)')
    if(changedRole)addEvent.run(req.authUser.id,user.id,req.authUser.username,user.username,'role_changed',user.role,role,now)
    if(changedActive)addEvent.run(req.authUser.id,user.id,req.authUser.username,user.username,active?'enabled':'disabled',user.role,role,now)
    if(!active)db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(user.id)
  })()
  res.json(userDto(db.prepare('SELECT * FROM users WHERE id=?').get(user.id)))
})
const backupNamePattern=/^tradeflow-[0-9]{8}-[0-9]{6}-[a-z0-9-]+\.sqlite$/
async function listBackups(){
  const names=(await readdir(backupDir)).filter(name=>backupNamePattern.test(name))
  const files=await Promise.all(names.map(async name=>{const info=await stat(resolve(backupDir,name));const remoteUploaded=await stat(`${resolve(backupDir,name)}.remote`).then(()=>true).catch(()=>false);return{name,size:info.size,createdAt:info.mtime.toISOString(),remoteUploaded}}))
  return files.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
}
let backupQueue=Promise.resolve()
function queueBackupOperation(operation){
  const queued=backupQueue.then(operation)
  backupQueue=queued.catch(()=>{})
  return queued
}
async function uploadBackupToRemote(name,destination=resolve(backupDir,name)){
  await s3Client.send(new PutObjectCommand({Bucket:backupBucket,Key:`${backupPrefix}/${name}`,Body:createReadStream(destination),ContentLength:(await stat(destination)).size,ContentType:'application/vnd.sqlite3',ServerSideEncryption:'AES256'}))
  await writeFile(`${destination}.remote`,new Date().toISOString(),'utf8')
}
async function createBackupNow(reason='manual'){
  const date=new Date(), stamp=date.toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)
  const suffix=randomBytes(3).toString('hex')
  const name=`tradeflow-${stamp}-${reason}-${suffix}.sqlite`, destination=resolve(backupDir,name)
  try{
    await db.backup(destination)
    validateBackupFile(destination)
  }catch(error){
    await rm(destination,{force:true}).catch(()=>{})
    throw error
  }
  let remoteUploaded=false,remoteError=backupRemoteConfigIssue||''
  if(s3Client){
    try{
      await uploadBackupToRemote(name,destination)
      remoteUploaded=true
    }catch(error){remoteError='远端上传失败；本地快照仍已创建，系统会自动重试';console.error('S3-compatible backup upload failed:',error.name||'UnknownError')}
  }
  const backups=await listBackups()
  for(const old of backups.slice(30)){await rm(resolve(backupDir,old.name),{force:true});await rm(`${resolve(backupDir,old.name)}.remote`,{force:true})}
  return {name,size:(await stat(destination)).size,createdAt:(await stat(destination)).mtime.toISOString(),remoteUploaded,remoteConfigured:Boolean(s3Client),remoteError}
}
function createBackup(reason='manual'){return queueBackupOperation(()=>createBackupNow(reason))}
async function retryPendingRemoteBackupsNow(){
  if(!s3Client)return{remoteConfigured:false,attempted:0,uploaded:0,failed:0,configurationIssue:backupRemoteConfigIssue||'尚未配置远端备份'}
  if(restoreInProgress)return{remoteConfigured:true,attempted:0,uploaded:0,failed:0,skipped:true}
  const pending=(await listBackups()).filter(backup=>!backup.remoteUploaded),result={remoteConfigured:true,attempted:pending.length,uploaded:0,failed:0}
  for(const backup of pending){
    try{await uploadBackupToRemote(backup.name);result.uploaded++}
    catch(error){result.failed++;console.error('S3-compatible backup retry failed:',error.name||'UnknownError')}
  }
  return result
}
function retryPendingRemoteBackups(){return queueBackupOperation(retryPendingRemoteBackupsNow)}
app.get('/api/backups',requireAdmin,async(_req,res)=>res.json(await listBackups()))
app.get('/api/backups/status',requireAdmin,async(_req,res)=>{
  const backups=await listBackups(),pendingRemoteCount=s3Client?backups.filter(backup=>!backup.remoteUploaded).length:null
  res.json({remoteConfigured:Boolean(s3Client),remoteType:s3Client?(process.env.BACKUP_S3_ENDPOINT?'S3 compatible':'Amazon S3'):null,remoteCredentialMode:useEcsRamRole?'ecs_ram_role':hasStaticBackupCredentials?'static':'unconfigured',configurationIssue:backupRemoteConfigIssue,retentionCount:30,automaticIntervalHours:24,remoteRetryIntervalMinutes:30,pendingRemoteCount,latestBackupName:backups[0]?.name||null,latestBackupRemoteUploaded:backups.length?backups[0].remoteUploaded:false})
})
app.get('/api/backups/remote',requireAdmin,async(_req,res)=>{
  if(!s3Client)return res.json({remoteConfigured:false,configurationIssue:backupRemoteConfigIssue||'尚未配置远端备份',backups:[]})
  try{
    const prefix=`${backupPrefix}/`,objects=[]
    let continuationToken,pages=0
    do{
      const page=await s3Client.send(new ListObjectsV2Command({Bucket:backupBucket,Prefix:prefix,ContinuationToken:continuationToken}))
      for(const object of page.Contents||[]){
        const name=String(object.Key||'').slice(prefix.length)
        if(name&&!name.includes('/')&&backupNamePattern.test(name))objects.push({name,size:object.Size||0,createdAt:object.LastModified?.toISOString?.()||null})
      }
      continuationToken=page.IsTruncated?page.NextContinuationToken:undefined
      pages+=1
    }while(continuationToken&&pages<10)
    objects.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''))
    res.json({remoteConfigured:true,backups:objects.slice(0,200),truncated:Boolean(continuationToken)||objects.length>200})
  }catch(error){console.error('Remote backup listing failed:',error.name||'UnknownError');res.status(502).json({error:'无法读取 OSS 备份列表，请检查 Endpoint、RAM 权限和网络'})}
})
app.post('/api/backups',requireAdmin,async(_req,res)=>{
  try{res.status(201).json(await createBackup('manual'))}catch(error){console.error(error);res.status(500).json({error:'创建备份失败，请检查磁盘空间和文件权限'})}
})
app.post('/api/backups/retry-remote',requireAdmin,async(_req,res)=>{
  if(!s3Client)return res.status(409).json({error:backupRemoteConfigIssue||'尚未配置远端备份'})
  try{res.json(await retryPendingRemoteBackups())}catch(error){console.error('Remote backup retry failed:',error.name||'UnknownError');res.status(500).json({error:'远端备份重试失败，请稍后再试'})}
})
app.get('/api/backups/:name/download',requireAdmin,async(req,res)=>{
  const name=String(req.params.name)
  if(!backupNamePattern.test(name))return res.status(400).json({error:'无效的备份文件名'})
  const path=resolve(backupDir,name)
  try{await stat(path);res.download(path,name)}catch{res.status(404).json({error:'备份文件不存在'})}
})
function validateBackupFile(path){
  let check
  try{check=new Database(path,{readonly:true,fileMustExist:true})}catch{throw Object.assign(new Error('备份文件无法读取或不是有效的 SQLite 数据库'),{status:400})}
  try{
    const integrity=check.pragma('integrity_check',{simple:true})
    const tables=new Set(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name))
    if(integrity!=='ok'||!['products','orders','order_items','users'].every(name=>tables.has(name)))throw Object.assign(new Error('备份完整性或应用数据表校验失败'),{status:400})
  }catch(error){if(error.status)throw error;throw Object.assign(new Error('备份文件完整性检查失败'),{status:400})}finally{check.close()}
}
async function restoreDatabaseFromFile(source){
  if(restoreInProgress)throw Object.assign(new Error('另一个数据库恢复任务正在执行'),{status:409})
  restoreInProgress=true
  const temporary=`${dbPath}.restore-temp-${randomBytes(4).toString('hex')}`,oldPath=`${dbPath}.pre-restore-${Date.now()}-${randomBytes(3).toString('hex')}`
  let currentMoved=false
  try{
    await copyFile(source,temporary)
    validateBackupFile(temporary)
    const safety=await createBackup('before-restore')
    db.pragma('wal_checkpoint(TRUNCATE)');db.close()
    await rename(dbPath,oldPath);currentMoved=true
    try{await rename(temporary,dbPath)}catch(error){await rename(oldPath,dbPath);currentMoved=false;throw error}
    await rm(`${dbPath}-wal`,{force:true});await rm(`${dbPath}-shm`,{force:true})
    db=new Database(dbPath);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON')
    applySchemaMigrations();applyBusinessMigrations()
    db.prepare('DELETE FROM auth_sessions').run()
    currentMoved=false
    await rm(oldPath,{force:true}).catch(error=>console.error('Could not remove pre-restore database file:',error.name||'UnknownError'))
    return safety.name
  }catch(error){
    try{
      if(currentMoved){if(db.open)db.close();await rm(dbPath,{force:true});await rename(oldPath,dbPath);currentMoved=false}
      if(!db.open){db=new Database(dbPath);db.pragma('journal_mode = WAL');db.pragma('foreign_keys = ON')}
    }catch(reopenError){console.error('Failed to reopen database after restore error',reopenError.name||'UnknownError')}
    throw error
  }finally{
    await rm(temporary,{force:true}).catch(()=>{});restoreInProgress=false
  }
}
app.post('/api/backups/:name/restore',requireAdmin,async(req,res)=>{
  const name=String(req.params.name)
  if(!backupNamePattern.test(name))return res.status(400).json({error:'无效的备份文件名'})
  if(req.body?.confirmation!=='RESTORE')return res.status(400).json({error:'恢复前请确认输入 RESTORE'})
  try{
    const source=resolve(backupDir,name);await stat(source)
    const safetyBackup=await restoreDatabaseFromFile(source)
    res.json({status:'restored',safetyBackup,loginRequired:true})
  }catch(error){
    if(error.status)return res.status(error.status).json({error:error.message})
    console.error('Local backup restore failed:',error.name||'UnknownError')
    res.status(500).json({error:'恢复失败，当前数据库已保留或恢复到操作前状态'})
  }
})
app.post('/api/backups/remote/:name/restore',requireAdmin,async(req,res)=>{
  const name=String(req.params.name)
  if(!backupNamePattern.test(name))return res.status(400).json({error:'无效的备份文件名'})
  if(req.body?.confirmation!=='RESTORE')return res.status(400).json({error:'恢复前请确认输入 RESTORE'})
  if(!s3Client)return res.status(409).json({error:backupRemoteConfigIssue||'尚未配置远端备份'})
  const staging=resolve(backupDir,`.remote-restore-${randomBytes(8).toString('hex')}.sqlite`)
  try{
    const object=await s3Client.send(new GetObjectCommand({Bucket:backupBucket,Key:`${backupPrefix}/${name}`}))
    if(!object.Body)return res.status(404).json({error:'OSS 备份对象没有数据'})
    await pipeline(object.Body,createWriteStream(staging,{flags:'wx',mode:0o600}))
    const safetyBackup=await restoreDatabaseFromFile(staging)
    res.json({status:'restored',safetyBackup,loginRequired:true,source:'oss'})
  }catch(error){
    if(error.name==='NoSuchKey'||error.name==='NotFound'||error.$metadata?.httpStatusCode===404)return res.status(404).json({error:'未找到该 OSS 备份对象'})
    if(error.status)return res.status(error.status).json({error:error.message})
    console.error('Remote backup restore failed:',error.name||'UnknownError')
    res.status(502).json({error:'OSS 备份下载或校验失败；当前数据库未替换'})
  }finally{await rm(staging,{force:true}).catch(()=>{})}
})
const dollars = cents => cents / 100
function productDto(row) { return { sku:row.sku,name:row.name,category:row.category,description:row.description,price:dollars(row.price_cents),stock:row.stock,reserved:row.reserved_stock||0,available:row.stock-(row.reserved_stock||0),threshold:row.threshold,active:Boolean(row.active),theme:row.theme,icon:row.icon } }
function orderDto(row) {
  const items = db.prepare('SELECT sku,product_name,qty,unit_price_cents FROM order_items WHERE order_id=? ORDER BY id').all(row.id).map(x=>({sku:x.sku,name:x.product_name,qty:x.qty,price:dollars(x.unit_price_cents)}))
  const events=db.prepare('SELECT e.id,e.event_type AS type,e.from_status AS fromStatus,e.to_status AS toStatus,e.reason,u.username AS changedBy,e.created_at AS date FROM order_events e LEFT JOIN users u ON u.id=e.changed_by WHERE e.order_id=? ORDER BY e.id').all(row.id)
  const held=db.prepare("SELECT sku,qty FROM order_inventory WHERE order_id=? AND state='reserved'").all(row.id)
  const expected=db.prepare('SELECT sku,SUM(qty) AS qty FROM order_items WHERE order_id=? GROUP BY sku').all(row.id)
  const hasAllHolds=expected.length===held.length&&expected.every(item=>held.some(hold=>hold.sku===item.sku&&hold.qty===item.qty))
  const inventoryNeedsReview=row.status==='ready'&&!hasAllHolds
  return {id:row.id,date:row.created_at,country:row.country,status:row.status,items,subtotal:dollars(row.subtotal_cents),shipping:dollars(row.shipping_cents),total:dollars(row.total_cents),carrier:row.carrier,tracking:row.tracking,cancelReason:row.cancel_reason,shippedAt:row.shipped_at,completedAt:row.completed_at,inventoryDeducted:Boolean(row.inventory_deducted),inventoryNeedsReview,events}
}
app.get('/api/health', async (_req,res) => {
  let database='connected',storage='writable'
  try{db.prepare('SELECT 1').get()}catch{database='unavailable'}
  try{await Promise.all([access(dataDir,fsConstants.W_OK),access(backupDir,fsConstants.W_OK)])}catch{storage='unavailable'}
  const status=database==='connected'&&storage==='writable'?'ok':'error'
  res.status(status==='ok'?200:503).json({status,database,storage,backups:{local:'available',remoteConfigured:Boolean(s3Client)},uptimeSeconds:Math.floor(process.uptime())})
})
app.get('/api/products', (req,res) => {
  const search = String(req.query.search||'').trim()
  const rows = db.prepare('SELECT * FROM products WHERE (? = \'\' OR sku LIKE ? OR name LIKE ?) ORDER BY rowid').all(search,`%${search}%`,`%${search}%`)
  res.json(rows.map(productDto))
})
app.get('/api/inventory/ledger', (req,res) => {
  const sku=String(req.query.sku||'').trim()
  const rows=db.prepare('SELECT l.id,l.sku,l.order_id AS orderId,l.event_type AS type,l.quantity_delta AS quantityDelta,l.reserved_delta AS reservedDelta,l.stock_after AS stockAfter,l.reserved_after AS reservedAfter,l.note,u.username AS changedBy,l.created_at AS date FROM inventory_ledger l LEFT JOIN users u ON u.id=l.changed_by WHERE (? = \'\' OR l.sku=?) ORDER BY l.id DESC LIMIT 200').all(sku,sku)
  res.json(rows)
})
app.post('/api/inventory/adjustments', requireAdmin, (req,res) => {
  const sku=String(req.body?.sku||'').trim().toUpperCase(),delta=Number(req.body?.delta),reason=String(req.body?.reason||'').trim()
  if(!sku||!Number.isSafeInteger(delta)||delta===0||Math.abs(delta)>1_000_000)return res.status(400).json({error:'请选择商品并填写非零整数调整数量（最多 1,000,000 件）'})
  if(reason.length<2||reason.length>120)return res.status(400).json({error:'调整原因请填写 2 到 120 个字'})
  const adjust=db.transaction(()=>{
    const product=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(sku)
    if(!product)throw Object.assign(new Error('未找到该 SKU 商品'),{status:404})
    const nextStock=product.stock+delta
    if(!Number.isSafeInteger(nextStock)||nextStock<product.reserved_stock)throw Object.assign(new Error(`调整后库存不能低于已预占库存（${product.reserved_stock} 件）`),{status:409})
    db.prepare('UPDATE products SET stock=? WHERE sku=?').run(nextStock,sku)
    const after=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(sku),timestamp=new Date().toISOString()
    db.prepare("INSERT INTO inventory_ledger(sku,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,changed_by,created_at) VALUES(?,'adjust',?,0,?,?,?,?,?)").run(sku,delta,after.stock,after.reserved_stock,reason,req.authUser.id,timestamp)
    return productDto(db.prepare('SELECT * FROM products WHERE sku=?').get(sku))
  })
  try{res.json(adjust())}catch(error){res.status(error.status||500).json({error:error.message||'库存调整失败'})}
})
app.post('/api/products', requireAdmin, (req,res) => {
  const body=req.body||{}, sku=String(body.sku||'').trim().toUpperCase(), name=String(body.name||'').trim(), price=Number(body.price), stock=Number(body.stock)
  const priceCents=Math.round(price*100)
  if (!sku||sku.length>100||!name||name.length>200||!Number.isSafeInteger(priceCents)||priceCents<=0||!Number.isSafeInteger(stock)||stock<0) return res.status(400).json({error:'请填写有效的 SKU、商品名称、正数售价和非负整数库存'})
  if (db.prepare('SELECT 1 FROM products WHERE sku=?').get(sku)) return res.status(409).json({error:'该 SKU 已存在'})
  try{
    const created=db.transaction(()=>{
      db.prepare('INSERT INTO products (sku,name,category,description,price_cents,stock,threshold,active,theme,icon) VALUES (?,?,?,?,?,?,8,1,\'thumb-blue\',\'Package\')').run(sku,name,String(body.category||'其他').trim(),String(body.description||'').trim(),priceCents,stock)
      db.prepare("INSERT INTO inventory_ledger(sku,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,changed_by,created_at) VALUES(?,'opening',?,0,?,0,'商品建档期初库存',?,?)").run(sku,stock,stock,req.authUser.id,new Date().toISOString())
      return productDto(db.prepare('SELECT * FROM products WHERE sku=?').get(sku))
    })()
    res.status(201).json(created)
  }catch(error){if(error.code==='SQLITE_CONSTRAINT_PRIMARYKEY')return res.status(409).json({error:'该 SKU 已存在'});throw error}
})
app.get('/api/orders', (req,res) => {
  const search=String(req.query.search||'').trim(), status=String(req.query.status||'all')
  const allowed=new Set(['all','processing','ready','shipped','completed','cancelled'])
  if(!allowed.has(status)) return res.status(400).json({error:'无效的订单状态筛选'})
  const rows=db.prepare('SELECT * FROM orders WHERE (? = \'\' OR id LIKE ?) AND (? = \'all\' OR status = ?) ORDER BY created_at DESC').all(search,`%${search}%`,status,status)
  res.json(rows.map(orderDto))
})
app.post('/api/orders/demo', requireRoles('admin','operator'), (req,res) => {
  const sku=String(req.body?.sku||'').trim().toUpperCase()
  const quantity=Number(req.body?.quantity)
  const country=String(req.body?.country||'').trim()
  const shippingAmount=Number(req.body?.shipping)
  const shippingCents=Math.round(shippingAmount*100)
  if(!sku||!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)return res.status(400).json({error:'请选择商品，并填写 1 到 1,000 之间的整数数量'})
  if(country.length<2||country.length>80)return res.status(400).json({error:'目的国家需为 2 到 80 个字符'})
  if(!Number.isFinite(shippingAmount)||shippingAmount<0||!Number.isSafeInteger(shippingCents))return res.status(400).json({error:'运费必须是有效的非负金额'})
  const create = db.transaction(() => {
    const nextNumber = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,9) AS INTEGER)),824)+1 AS value FROM orders WHERE id LIKE 'TF-2026-%'").get().value
    const id = `TF-2026-${String(nextNumber).padStart(5,'0')}`
    const product=db.prepare('SELECT sku,name,price_cents FROM products WHERE sku=?').get(sku)
    if(!product)throw Object.assign(new Error('所选商品不存在'),{status:404})
    const subtotal=product.price_cents*quantity
    const total=subtotal+shippingCents
    if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(total))throw Object.assign(new Error('订单金额超出允许范围'),{status:400})
    db.prepare('INSERT INTO orders (id,created_at,country,status,subtotal_cents,shipping_cents,total_cents) VALUES (?,?,?,\'processing\',?,?,?)').run(id,new Date().toISOString(),country,subtotal,shippingCents,total)
    db.prepare('INSERT INTO order_items (order_id,sku,product_name,qty,unit_price_cents) VALUES (?,?,?,?,?)').run(id,product.sku,product.name,quantity,product.price_cents)
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  })
  try { res.status(201).json(orderDto(create())) }
  catch(error) { res.status(error.status||500).json({error:error.message||'创建演示订单失败'}) }
})
app.get('/api/orders/:id', (req,res) => { const row=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if(!row)return res.status(404).json({error:'未找到该订单'}); res.json(orderDto(row)) })
app.post('/api/orders/:id/confirm', requireRoles('admin','operator'), (req,res) => {
  const confirm=db.transaction(id=>{
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if(!row)throw Object.assign(new Error('未找到该订单'),{status:404})
    if(row.status!=='processing')throw Object.assign(new Error(`当前订单状态为“${({ready:'待发货',shipped:'已发货',completed:'已完成',cancelled:'已取消'})[row.status]||row.status}”，不能确认`),{status:409})
    const lines=db.prepare('SELECT sku,product_name,SUM(qty) AS qty FROM order_items WHERE order_id=? GROUP BY sku,product_name').all(id)
    for(const item of lines){const p=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(item.sku);const available=p?p.stock-p.reserved_stock:0;if(!p||available<item.qty)throw Object.assign(new Error(`库存不足：${item.product_name}，可用 ${available} 件，需要 ${item.qty} 件`),{status:409})}
    for(const item of lines){db.prepare('UPDATE products SET reserved_stock=reserved_stock+? WHERE sku=?').run(item.qty,item.sku);db.prepare("INSERT INTO order_inventory(order_id,sku,qty,state) VALUES(?,?,?,'reserved')").run(id,item.sku,item.qty);const p=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(item.sku);db.prepare("INSERT INTO inventory_ledger(sku,order_id,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,created_at) VALUES(?,?,'reserve',0,?,?,?,?,?)").run(item.sku,id,item.qty,p.stock,p.reserved_stock,`订单 ${id} 确认，预占库存`,new Date().toISOString())}
    const changedAt=new Date().toISOString()
    db.prepare("UPDATE orders SET status='ready' WHERE id=? AND status='processing'").run(id)
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,changed_by,created_at) VALUES(?,'confirm','processing','ready',?,?)").run(id,req.authUser.id,changedAt)
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  })
  try{res.json(orderDto(confirm(req.params.id)))}catch(error){res.status(error.status||500).json({error:error.message||'确认订单失败'})}
})
app.post('/api/orders/:id/cancel', requireRoles('admin','operator'), (req,res) => {
  const reason=String(req.body?.reason||'').trim()
  if(reason.length<2||reason.length>120)return res.status(400).json({error:'请填写 2 到 120 个字的取消原因'})
  const cancel=db.transaction(id=>{
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if(!row)throw Object.assign(new Error('未找到该订单'),{status:404})
    if(!['processing','ready'].includes(row.status))throw Object.assign(new Error('只有待处理或待发货订单可以取消'),{status:409})
    if(row.status==='ready'){
      const holds=db.prepare("SELECT sku,qty FROM order_inventory WHERE order_id=? AND state='reserved'").all(id)
      for(const hold of holds){db.prepare('UPDATE products SET reserved_stock=reserved_stock-? WHERE sku=? AND reserved_stock>=?').run(hold.qty,hold.sku,hold.qty);db.prepare("UPDATE order_inventory SET state='released' WHERE order_id=? AND sku=?").run(id,hold.sku);const p=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(hold.sku);db.prepare("INSERT INTO inventory_ledger(sku,order_id,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,created_at) VALUES(?,?,'release',0,?,?,?,?,?)").run(hold.sku,id,-hold.qty,p.stock,p.reserved_stock,`订单 ${id} 取消，释放预占库存`,new Date().toISOString())}
    }
    db.prepare("UPDATE orders SET status='cancelled',cancel_reason=? WHERE id=?").run(reason,id)
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,reason,changed_by,created_at) VALUES(?,'cancel',?,'cancelled',?,?,?)").run(id,row.status,reason,req.authUser.id,new Date().toISOString())
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  })
  try{res.json(orderDto(cancel(req.params.id)))}catch(error){res.status(error.status||500).json({error:error.message||'取消订单失败'})}
})
app.post('/api/orders/:id/ship', requireRoles('admin','operator'), (req,res) => {
  const carrier=String(req.body?.carrier||'').trim(), tracking=String(req.body?.tracking||'').trim()
  if(!carrier||!tracking)return res.status(400).json({error:'承运商和物流追踪号均为必填项'})
  const ship=db.transaction(id=>{
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if(!row)throw Object.assign(new Error('未找到该订单'),{status:404})
    if(row.status!=='ready')throw Object.assign(new Error('该订单不是待发货状态，无法发货'),{status:409})
    if(row.inventory_deducted)throw Object.assign(new Error('该订单库存已扣减，不能重复发货'),{status:409})
    const items=db.prepare("SELECT oi.sku,oi.product_name,oi.qty,inv.qty AS reserved_qty,p.stock,p.reserved_stock,inv.state FROM (SELECT sku,MAX(product_name) AS product_name,SUM(qty) qty FROM order_items WHERE order_id=? GROUP BY sku) oi LEFT JOIN order_inventory inv ON inv.order_id=? AND inv.sku=oi.sku LEFT JOIN products p ON p.sku=oi.sku").all(id,id)
    if(!items.length||items.some(item=>item.state!=='reserved'||item.qty!==item.reserved_qty||!Number.isSafeInteger(item.stock)||!Number.isSafeInteger(item.reserved_stock)||item.qty>item.reserved_stock||item.qty>item.stock))throw Object.assign(new Error('该订单的库存预占记录不完整，请检查库存流水'),{status:409})
    const timestamp=new Date().toISOString()
    for(const item of items){db.prepare('UPDATE products SET stock=stock-?,reserved_stock=reserved_stock-? WHERE sku=? AND stock>=? AND reserved_stock>=?').run(item.qty,item.qty,item.sku,item.qty,item.qty);db.prepare("UPDATE order_inventory SET state='consumed' WHERE order_id=? AND sku=? AND state='reserved'").run(id,item.sku);const p=db.prepare('SELECT stock,reserved_stock FROM products WHERE sku=?').get(item.sku);db.prepare("INSERT INTO inventory_ledger(sku,order_id,event_type,quantity_delta,reserved_delta,stock_after,reserved_after,note,created_at) VALUES(?,?,'ship',?,?,?,?,?,?)").run(item.sku,id,-item.qty,-item.qty,p.stock,p.reserved_stock,`订单 ${id} 发货，扣减实物库存`,timestamp)}
    db.prepare("UPDATE orders SET status='shipped',carrier=?,tracking=?,inventory_deducted=1,shipped_at=? WHERE id=? AND status='ready'").run(carrier,tracking,timestamp,id)
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,changed_by,created_at) VALUES(?,'ship','ready','shipped',?,?)").run(id,req.authUser.id,timestamp)
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  })
  try{res.json(orderDto(ship(req.params.id)))}catch(error){res.status(error.status||500).json({error:error.message||'发货失败'})}
})
app.post('/api/orders/:id/complete', requireRoles('admin','operator'), (req,res) => {
  const complete=db.transaction(id=>{
    const row=db.prepare('SELECT * FROM orders WHERE id=?').get(id)
    if(!row)throw Object.assign(new Error('未找到该订单'),{status:404})
    if(row.status!=='shipped')throw Object.assign(new Error('只有已发货订单可以标记为已完成'),{status:409})
    const timestamp=new Date().toISOString()
    db.prepare("UPDATE orders SET status='completed',completed_at=? WHERE id=? AND status='shipped'").run(timestamp,id)
    db.prepare("INSERT INTO order_events(order_id,event_type,from_status,to_status,changed_by,created_at) VALUES(?,'complete','shipped','completed',?,?)").run(id,req.authUser.id,timestamp)
    return db.prepare('SELECT * FROM orders WHERE id=?').get(id)
  })
  try{res.json(orderDto(complete(req.params.id)))}catch(error){res.status(error.status||500).json({error:error.message||'完成订单失败'})}
})
if(process.env.NODE_ENV==='production'){
  app.use(express.static(resolve(root,'dist'),{index:false,maxAge:'1h'}))
  app.get(/^(?!\/api(?:\/|$)).*/,(_req,res)=>res.sendFile(resolve(root,'dist','index.html')))
}
app.use((error,_req,res,_next)=>{console.error(error);res.status(500).json({error:'服务暂时不可用'})})
const port=Number(process.env.PORT||3001)
const host=process.env.HOST||(process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1')
app.listen(port,host,()=>{
  console.log(`TradeFlow server ready at http://${host}:${port}`)
  listBackups().then(files=>{
    if(!files.some(file=>file.name.includes('-auto-')||file.name.includes('-daily-'))){
      return createBackup('auto').then(item=>console.log(`Initial automatic backup created: ${item.name}`))
    }
  }).then(()=>retryPendingRemoteBackups()).then(result=>{if(result.uploaded)console.log(`Recovered ${result.uploaded} pending remote backup(s).`)}).catch(error=>console.error('Initial automatic database backup failed',error))
})
const backupTimer=setInterval(()=>{
  if(restoreInProgress)return
  createBackup('daily').then(item=>console.log(`Automatic database backup created: ${item.name}`)).catch(error=>console.error('Automatic database backup failed',error))
},24*60*60*1000)
backupTimer.unref()
const remoteRetryTimer=setInterval(()=>{
  if(restoreInProgress||!s3Client)return
  retryPendingRemoteBackups().then(result=>{if(result.uploaded||result.failed)console.log(`Remote backup retry finished: ${result.uploaded} uploaded, ${result.failed} failed.`)}).catch(error=>console.error('Remote backup retry failed',error.name||'UnknownError'))
},30*60*1000)
remoteRetryTimer.unref()
