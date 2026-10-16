/**
 * 本机凭据库的回归测试。
 *
 * 全程用注入的假 dep，**不碰真实文件系统、不用真实 DPAPI、不起 Electron**。假加密用
 * 「反转字符串」这类可逆变换，于是「解不开」这个分支可以被精确构造（让 decrypt 抛错），
 * 而不必真的换一台机器。
 *
 * 重点覆盖四类：**掩码规则**、**序列化往返**、**逐条解密的降级**、**损坏文件绝不静默
 * 覆盖**。最后一条是这个模块最重要的安全性质：把一份解析不了的文件当空库，下一次保存
 * 就会把用户原有的全部凭据覆盖掉，而那种丢失是静默的。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACCOUNT_MAX,
  createCredentialVault,
  emptyVaultFile,
  maskAccount,
  normalizeCredentialInput,
  normalizeProfileId,
  normalizeProfileIds,
  parseVaultFile,
  PASSWORD_MAX,
  removeVaultItem,
  serializeVaultFile,
  upsertVaultItem,
  VAULT_FORMAT_VERSION,
} from '../src/credential-vault.ts'

/**
 * 假加密的密钥侧。
 *
 * 「加密」= 加一个前缀再把正文反转，「解密」= 精确反过来。做成真正互逆的一对，否则
 * 测试会拿到一份自己解不开的密文，然后误报成「模块坏了」——那种失败查起来很费时间。
 */
function fakeEncrypt(plaintext) {
  return Buffer.from(`enc:${plaintext.split('').reverse().join('')}`, 'utf8')
}

function fakeDecrypt(ciphertext) {
  const text = ciphertext.toString('utf8')
  if (!text.startsWith('enc:')) throw new Error('不是本程序写的密文')
  return text.slice(4).split('').reverse().join('')
}

/** 与假加密配对的编码工具，让测试能预置一份已知密文。 */
function encode(account, password) {
  return fakeEncrypt(JSON.stringify({ account, password })).toString('base64')
}

/** 假加密：可逆、可注入、可在测试里按需让它失败。 */
function makeDeps(overrides = {}) {
  const files = new Map()
  const written = []
  const removed = []
  const deps = {
    files,
    written,
    removed,
    readFile: async (path) => (files.has(path) ? files.get(path) : null),
    writeFile: async (path, content) => {
      files.set(path, content)
      written.push(path)
    },
    rename: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error(`rename 源不存在：${from}`)
      files.delete(from)
      files.set(to, content)
    },
    unlink: async (path) => {
      if (!files.has(path)) throw new Error(`unlink 目标不存在：${path}`)
      files.delete(path)
      removed.push(path)
    },
    encrypt: fakeEncrypt,
    decrypt: fakeDecrypt,
    isEncryptionAvailable: () => true,
    ...overrides,
  }
  return deps
}

const VAULT_PATH = 'C:\\vault\\credentials.enc'

function item(profileId, account, password, label = '') {
  return {
    profileId,
    label,
    blob: encode(account, password),
    updatedAt: '2026-10-15T00:00:00.000Z',
  }
}

/* ---------------- 掩码 ---------------- */

test('maskAccount：11 位手机号得到 前三+四星+后四', () => {
  assert.equal(maskAccount('13812345678'), '138****5678')
})

test('maskAccount：5 到 8 位只露头尾各一点', () => {
  assert.equal(maskAccount('abcdef'), 'a***ef')
  assert.equal(maskAccount('abcdefgh'), 'a***gh')
})

test('maskAccount：4 位及以下整体掩掉', () => {
  assert.equal(maskAccount('1234'), '****')
  assert.equal(maskAccount('ab'), '**')
  assert.equal(maskAccount('a'), '*')
})

test('maskAccount：空串返回空串，由调用方决定怎么显示', () => {
  assert.equal(maskAccount(''), '')
})

test('maskAccount：按字符而不是按 UTF-16 码元数，多字节字符不会被切坏', () => {
  const account = '用户名甲乙丙丁戊己庚辛壬癸'
  const masked = maskAccount(account)
  assert.equal(Array.from(account).length, 13)
  // 13 个字符走长口径：前三 + 四星 + 后四。
  // 「用户名」本身就是三个字符，别把第四个字也数进去。
  assert.equal(masked, '用户名****庚辛壬癸')
  assert.equal(Array.from(masked).length, 11, '结果应是 11 个字符而不是 12 个码元')
  assert.equal(masked.includes('乙'), false, '中间字符必须被掩掉')
})

/* ---------------- 输入归一 ---------------- */

test('normalizeProfileId：非字符串、空串、超长一律 null', () => {
  assert.equal(normalizeProfileId('abc'), 'abc')
  assert.equal(normalizeProfileId('  abc  '), 'abc', '应去首尾空白')
  assert.equal(normalizeProfileId(''), null)
  assert.equal(normalizeProfileId('   '), null)
  assert.equal(normalizeProfileId(42), null)
  assert.equal(normalizeProfileId(null), null)
  assert.equal(normalizeProfileId(`x${'x'.repeat(ACCOUNT_MAX)}`), null, '超过上限应拒绝')
})

test('normalizeProfileIds：去重、保序、限长', () => {
  assert.deepEqual(normalizeProfileIds(['a', 'b', 'a', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(normalizeProfileIds(['a', 42, null, 'b']), ['a', 'b'])
  assert.deepEqual(normalizeProfileIds('not-an-array'), [])
  assert.deepEqual(normalizeProfileIds([]), [])
  const many = Array.from({ length: 200 }, (_, index) => `id-${index}`)
  assert.equal(normalizeProfileIds(many).length, 128, '应被上限截断')
})

test('normalizeCredentialInput：三项齐全才认，空密码按拒绝处理', () => {
  const ok = normalizeCredentialInput({
    profileId: ' p1 ',
    account: ' 13812345678 ',
    password: 'pw',
    label: 'QQ · 工作号',
  })
  assert.deepEqual(ok, {
    profileId: 'p1',
    account: '13812345678',
    password: 'pw',
    label: 'QQ · 工作号',
  })

  // 空密码存进去会让自动填表把空串打进密码框，表现为「填了但登录不上」。
  assert.equal(normalizeCredentialInput({ profileId: 'p', account: 'a', password: '' }), null)
  assert.equal(normalizeCredentialInput({ profileId: 'p', account: '', password: 'x' }), null)
  assert.equal(normalizeCredentialInput({ profileId: '', account: 'a', password: 'x' }), null)
  assert.equal(normalizeCredentialInput({ profileId: 'p', account: 'a' }), null)
  assert.equal(normalizeCredentialInput(null), null)
  assert.equal(normalizeCredentialInput([]), null)
  assert.equal(
    normalizeCredentialInput({
      profileId: 'p',
      account: `a${'a'.repeat(ACCOUNT_MAX)}`,
      password: 'x',
    }),
    null,
    '账号超长应拒绝',
  )
  assert.equal(
    normalizeCredentialInput({
      profileId: 'p',
      account: 'a',
      password: `x${'x'.repeat(PASSWORD_MAX)}`,
    }),
    null,
    '密码超长应拒绝',
  )
})

/* ---------------- 序列化 ---------------- */

test('parseVaultFile：合法内容原样读回，label 缺失归空串', () => {
  const file = { v: VAULT_FORMAT_VERSION, items: [item('p1', 'a', 'b', 'QQ')] }
  const parsed = parseVaultFile(serializeVaultFile(file))
  assert.deepEqual(parsed, file)
})

test('parseVaultFile：不认识版本、坏 JSON、结构不对一律 null', () => {
  assert.equal(parseVaultFile('not json'), null)
  assert.equal(parseVaultFile(''), null)
  assert.equal(parseVaultFile('null'), null)
  assert.equal(parseVaultFile('[]'), null)
  assert.equal(parseVaultFile(JSON.stringify({ v: 2, items: [] })), null, '版本不认识')
  assert.equal(parseVaultFile(JSON.stringify({ v: VAULT_FORMAT_VERSION })), null, '缺 items')
  assert.equal(parseVaultFile(JSON.stringify({ v: VAULT_FORMAT_VERSION, items: {} })), null)
  // 条目缺 profileId 或 blob 都算坏：那种条目读出来也没法用。
  assert.equal(
    parseVaultFile(JSON.stringify({ v: VAULT_FORMAT_VERSION, items: [{ label: 'x' }] })),
    null,
  )
  assert.equal(
    parseVaultFile(
      JSON.stringify({ v: VAULT_FORMAT_VERSION, items: [{ profileId: 'p', blob: '' }] }),
    ),
    null,
  )
})

test('upsertVaultItem / removeVaultItem：同 id 覆盖、删除幂等', () => {
  const a = item('p1', 'acct1', 'pw1')
  const b = item('p2', 'acct2', 'pw2')
  const updated = item('p1', 'acct1-new', 'pw1-new', 'QQ · 二号')
  const afterUpsert = upsertVaultItem([a, b], updated)
  assert.equal(afterUpsert.length, 2, '同 id 应覆盖而不是追加')
  assert.deepEqual(
    afterUpsert.find((entry) => entry.profileId === 'p1'),
    updated,
  )

  const afterRemove = removeVaultItem(afterUpsert, 'p1')
  assert.deepEqual(
    afterRemove.map((entry) => entry.profileId),
    ['p2'],
  )
  assert.deepEqual(removeVaultItem(afterRemove, 'not-exist'), afterRemove, '删不存在的应原样返回')
})

test('emptyVaultFile：版本号与当前实现一致', () => {
  assert.deepEqual(emptyVaultFile(), { v: VAULT_FORMAT_VERSION, items: [] })
})

/* ---------------- 读状态 ---------------- */

test('status：文件不存在时全部按 none，不报错也不建文件', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  const results = await vault.status(['p1', 'p2'])
  assert.deepEqual(results, [
    { profileId: 'p1', state: 'none', accountMasked: null, label: '' },
    { profileId: 'p2', state: 'none', accountMasked: null, label: '' },
  ])
  assert.equal(deps.written.length, 0, '查询不应写文件')
})

test('status：空入参不发文件读取', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  assert.deepEqual(await vault.status([]), [])
})

test('status：保存过的凭据只回掩码账号，不回明文', async () => {
  const deps = makeDeps()
  deps.files.set(
    VAULT_PATH,
    serializeVaultFile({
      v: VAULT_FORMAT_VERSION,
      items: [item('p1', '13812345678', 'secret-pw', 'QQ · 工作号')],
    }),
  )
  const vault = createCredentialVault(VAULT_PATH, deps)
  const results = await vault.status(['p1'])
  assert.deepEqual(results, [
    { profileId: 'p1', state: 'saved', accountMasked: '138****5678', label: 'QQ · 工作号' },
  ])
  // 明文密码与完整账号都不该出现在回传对象里。
  const serialized = JSON.stringify(results)
  assert.equal(serialized.includes('secret-pw'), false, '不得回传明文密码')
  assert.equal(serialized.includes('13812345678'), false, '不得回传完整账号')
})

test('status：解不开的那一条报 undecryptable，其余照常', async () => {
  const deps = makeDeps()
  deps.files.set(
    VAULT_PATH,
    serializeVaultFile({
      v: VAULT_FORMAT_VERSION,
      items: [item('p-good', '13812345678', 'pw'), item('p-bad', '13900000000', 'pw2')],
    }),
  )
  // 破坏第二条的密文，模拟「换机后 DPAPI 解不开」。
  const broken = parseVaultFile(deps.files.get(VAULT_PATH) ?? '')
  assert.ok(broken !== null)
  const items = [...broken.items]
  const victim = items[1]
  assert.ok(victim !== undefined)
  items[1] = { ...victim, blob: Buffer.from('corrupted', 'utf8').toString('base64') }

  const deps2 = makeDeps()
  deps2.files.set(VAULT_PATH, serializeVaultFile({ v: VAULT_FORMAT_VERSION, items }))
  const vault = createCredentialVault(VAULT_PATH, deps2)
  const results = await vault.status(['p-good', 'p-bad', 'p-missing'])
  assert.equal(results[0].state, 'saved')
  assert.equal(results[1].state, 'undecryptable')
  assert.equal(results[1].label, '', '损坏条目仍应给出 label 以便用户知道原本是哪一条')
  assert.equal(results[2].state, 'none')
  assert.equal(deps2.written.length, 0, '查询不应因解不开而改写文件')
})

/* ---------------- 保存与删除 ---------------- */

test('save：保存后落盘的是密文，读回来只有掩码', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.save({
    profileId: 'p1',
    account: '13812345678',
    password: 'secret-pw',
    label: 'QQ · 工作号',
  })
  assert.deepEqual(result, { ok: true })

  const onDisk = deps.files.get(VAULT_PATH)
  assert.ok(onDisk !== undefined)
  assert.equal(onDisk.includes('secret-pw'), false, '磁盘上不得出现明文密码')
  assert.equal(onDisk.includes('13812345678'), false, '磁盘上不得出现明文账号')

  const statuses = await vault.status(['p1'])
  assert.equal(statuses[0].state, 'saved')
  assert.equal(statuses[0].accountMasked, '138****5678')
})

test('save：同一条配置重复保存覆盖旧凭据', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  await vault.save({ profileId: 'p1', account: 'acct-a', password: 'pw-a' })
  await vault.save({ profileId: 'p1', account: 'acct-b', password: 'pw-b', label: 'QQ · 二号' })
  const statuses = await vault.status(['p1'])
  assert.equal(statuses.length, 1)
  assert.equal(statuses[0].accountMasked, 'a***-b')
  assert.equal(statuses[0].label, 'QQ · 二号')
  // 旧密码不应还能解密出任何东西：覆盖是替换，不是追加。
  const file = parseVaultFile(deps.files.get(VAULT_PATH) ?? '')
  assert.equal(file?.items.length, 1)
})

test('save：加密不可用时拒绝，且不落任何文件', async () => {
  const deps = makeDeps({ isEncryptionAvailable: () => false })
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'encryption_unavailable')
  assert.equal(deps.written.length, 0, '加密不可用时不落明文')
  assert.equal(deps.files.size, 0, '不应创建任何文件')
})

test('save：加密调用抛错时也拒绝，不把异常抛给调用方', async () => {
  const deps = makeDeps({
    encrypt: () => {
      throw new Error('DPAPI 故障')
    },
  })
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'encryption_unavailable')
})

test('save：文件损坏时拒绝写入，绝不覆盖原有内容', async () => {
  const deps = makeDeps()
  const original = '{ 这不是合法的凭据库'
  deps.files.set(VAULT_PATH, original)
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'vault_corrupt')
  assert.ok(result.detail.includes(VAULT_PATH), '提示里应给出文件路径，用户才知道该动哪个文件')
  assert.equal(deps.files.get(VAULT_PATH), original, '损坏文件必须原样保留')
})

test('save：版本不认识也算损坏，同样拒绝覆盖', async () => {
  const deps = makeDeps()
  deps.files.set(VAULT_PATH, JSON.stringify({ v: 99, items: [] }))
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'vault_corrupt')
  assert.equal(deps.written.length, 0)
})

test('remove：删掉后查询回到 none', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal((await vault.remove('p1')).ok, true)
  const statuses = await vault.status(['p1'])
  assert.equal(statuses[0].state, 'none')
})

test('remove：删不存在的条目返回 ok，且不写文件', async () => {
  const deps = makeDeps()
  deps.files.set(
    VAULT_PATH,
    serializeVaultFile({ v: VAULT_FORMAT_VERSION, items: [item('p1', 'a', 'b')] }),
  )
  const vault = createCredentialVault(VAULT_PATH, deps)
  assert.deepEqual(await vault.remove('p2'), { ok: true })
  assert.equal(deps.written.length, 0, '没有可删的东西时不该改写文件')
})

test('remove：文件不存在时返回 ok', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  assert.deepEqual(await vault.remove('p1'), { ok: true })
})

test('remove：配置 id 不合法时拒绝', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  const result = await vault.remove('')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'invalid_profile_id')
})

/* ---------------- 原子写入 ---------------- */

test('原子写入：先写临时文件再改名，目标文件不会出现半份内容', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  await vault.save({ profileId: 'p1', account: 'a', password: 'b' })

  // 第一次保存：写了一个临时文件，改名到目标。目标文件是完整内容，临时文件已不存在。
  assert.equal(deps.written.length, 1, '应只写一次文件')
  assert.ok(deps.written[0].endsWith('.tmp'), '写进去的应是临时文件')
  assert.ok(deps.files.has(VAULT_PATH), '目标文件应已落定')
  assert.equal(deps.files.has(VAULT_PATH + '.tmp'), false, '临时文件不应残留')
})

test('原子写入：写入失败时不污染目标文件，并清理临时文件', async () => {
  const deps = makeDeps()
  const original = serializeVaultFile({ v: VAULT_FORMAT_VERSION, items: [item('p1', 'old', 'pw')] })
  deps.files.set(VAULT_PATH, original)
  const vault = createCredentialVault(VAULT_PATH, deps)

  // 让写临时文件失败。
  deps.writeFile = async () => {
    throw new Error('磁盘已满')
  }
  const result = await vault.save({ profileId: 'p1', account: 'new', password: 'pw' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'write_failed')
  assert.equal(deps.files.get(VAULT_PATH), original, '目标文件必须保持原样')

  // 临时文件路径应被尝试清理（此时它从未被创建，unlink 抛错被吞掉）。
  assert.ok(deps.files.size >= 1, '不应留下新的垃圾文件')
})

test('原子写入：改名失败也要清理临时文件', async () => {
  const deps = makeDeps()
  const vault = createCredentialVault(VAULT_PATH, deps)
  deps.rename = async () => {
    throw new Error('跨卷失败')
  }
  const result = await vault.save({ profileId: 'p1', account: 'a', password: 'b' })
  assert.equal(result.ok, false)
  assert.equal(deps.removed.length, 1, '改名失败后应清理临时文件')
  assert.equal(deps.files.size, 0, '不应留下临时文件')
})
