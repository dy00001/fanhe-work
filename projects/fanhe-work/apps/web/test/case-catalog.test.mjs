/**
 * 案例清单的回归测试。
 *
 * 与其它前端测试同款：Node 内置测试器直接测源码，启用类型擦除即可。
 *
 * 这里钉七组不变量：
 *   1. 十四个品类一个不少、顺序固定；
 *   2. `id` 唯一、非空、英文小写加连字符，且与共享包的白名单逐项一致；
 *   3. 每个非空 `cover` 指向的文件真实存在于 `public/cases/`，非空，且确实是 WebP；
 *   4. 封面文件名与品类 `id` 一一对应；
 *   5. 每个案例位的图同样真实存在、是 WebP，且 `id` / `categoryId` / 文件名三者对得上；
 *   6. 磁盘上没有「清单里不存在」的孤儿图 —— 反向检查，第 5 条查不出来；
 *   7. 允许某一格只有封面（靠上传填充），但必须是显式登记过的那一格。
 *
 * 界面本身（按钮开合、图集翻页、裁切效果）不在这里，它要靠浏览器跑起来才判定得了。
 *
 * **第 3 与第 5 条是本轮的重点。** 静态资源最容易出的不是语法错误，是「路径写对了但
 * 文件没进仓库」或者「文件进了但读不出来」。这类问题在浏览器里表现为一块空白，控制台
 * 只有一行 404，很容易被当成「还没配图」。所以断言落在字节上。
 *
 * **第 6 条解决另一个方向的问题：改了张数、旧图没删。** 目录里多出 `cabinet-5.webp`
 * 不会有任何界面症状，但它会一直躺在仓库里，且让「一共多少张」这种人工统计失去意义。
 *
 * **校验函数自己也做了反例测试。** 一个永远返回通过的校验函数，会让上面所有断言一起
 * 变成摆设，而它的失效是静默的。反例测试是唯一能观察到它「真的会失败」的手段。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CASE_CATEGORY_IDS } from '@fanhe/shared'

import { CASE_CATEGORIES } from '../src/lib/case-catalog.ts'

/**
 * 原型里的九个主力品类、2026-10-29 追加的四个空间品类、以及 2026-10-30 追加的
 * 「特殊工艺」，顺序即界面顺序。改动这一行等于改产品口径，必须是有意的。
 */
const EXPECTED_NAMES = [
  '橱柜',
  '衣柜',
  '书柜',
  '鞋柜',
  '酒柜',
  '套装门',
  '电视柜',
  '餐边柜',
  '护墙板',
  '榻榻米',
  '阳台柜',
  '浴室柜',
  '铝木柜',
  '特殊工艺',
]

/**
 * 当前刻意没有静态案例的品类。
 *
 * 这**不是给配置漏配开的免罪符**，是钉住一个产品状态：特殊工艺这一格先只有封面，
 * 内部图片由用户在图集窗口里自己上传（落在 `case_uploads`，与这份静态清单无关）。
 * 因此它必须同时满足「cases 为空」与「封面存在」—— 后者由封面断言管，这里再卡一次
 * 「空得有理」。哪天它有了静态案例，这条会红，提醒把这个 id 从集合里删掉。
 */
const UPLOAD_ONLY_CATEGORY_IDS = new Set(['special-craft'])

/**
 * `id` 用英文是为了将来进 URL 与接口参数时不必再转一层拼音。
 * 中文 id 会让 `?category=橱柜` 这种参数走两次编码，调试日志也读不顺。
 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

/** 静态图的合法地址形状。限死字符集同时也挡住了 `../` 这类目录穿越写法。 */
const IMAGE_PATTERN = /^\/cases\/(album\/)?[a-z0-9-]+\.webp$/

/** `apps/web/public/cases/` 的绝对路径。相对 test/ 上跳一级。 */
const CASES_DIR = fileURLToPath(new URL('../public/cases/', import.meta.url))
const ALBUM_DIR = `${CASES_DIR}album/`

/**
 * 断言一个地址在磁盘上真实存在、体积合理、且是 WebP 容器。
 *
 * 抽成函数是为了能做反例测试：把假路径喂进来，确认它确实会抛错。如果这段逻辑写死在
 * 测试用例里，就没法单独验证它。
 */
function assertImageFile(src) {
  assert.equal(typeof src, 'string', '图片地址应为字符串')
  assert.match(src, IMAGE_PATTERN, `图片地址格式不对：${src}`)

  const abs = `${CASES_DIR}${src.slice('/cases/'.length)}`

  let size
  try {
    size = statSync(abs).size
  } catch {
    assert.fail(`图片文件不存在：${abs}`)
  }
  // 1 KB 是经验下限：正常图 8~80 KB，比这更小基本是断链文件或纯色占位。
  assert.ok(size > 1024, `图片文件过小，疑似占位或损坏：${abs}（${size} 字节）`)

  // WebP 是 RIFF 容器：第 0~3 字节 `RIFF`，第 8~11 字节 `WEBP`。
  const head = readFileSync(abs).subarray(0, 12)
  assert.equal(head.subarray(0, 4).toString('latin1'), 'RIFF', `${abs} 不是 RIFF 容器`)
  assert.equal(head.subarray(8, 12).toString('latin1'), 'WEBP', `${abs} 不是 WebP`)
}

test('十四个品类齐全且顺序固定', () => {
  assert.deepEqual(
    CASE_CATEGORIES.map((category) => category.name),
    EXPECTED_NAMES,
  )
})

test('前端清单与共享包的品类 id 白名单逐项一致', () => {
  // 服务端拿 `CASE_CATEGORY_IDS` 挡非法品类，前端拿 `CASE_CATEGORIES` 画界面。只在
  // 一边加品类，表现是「首页有这张卡、点进去上传被 400 拒掉」，而两边的测试各自
  // 都是绿的。这条把两份清单钉在一起。
  assert.deepEqual(
    CASE_CATEGORIES.map((category) => category.id),
    [...CASE_CATEGORY_IDS],
  )
})

test('品类 id 唯一且非空，且符合英文拼写约束', () => {
  const ids = CASE_CATEGORIES.map((category) => category.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.ok(id.length > 0, '品类 id 不能为空串')
    assert.match(id, ID_PATTERN, `品类 id 应为英文小写加连字符：${id}`)
  }
})

test('每个非空封面都指向真实存在且格式正确的 WebP', () => {
  const withCover = CASE_CATEGORIES.filter((category) => category.cover !== null)
  // 若某次改动把所有 cover 都退回 null，下面整个循环会空转、这条测试仍然通过。
  // 先卡住「至少有封面」，空转就不可能发生。
  assert.ok(withCover.length > 0, '没有任何品类配置封面，这条断言等于没测')
  for (const category of withCover) {
    assertImageFile(category.cover)
  }
})

test('封面文件名与品类 id 一一对应', () => {
  // 挡住复制粘贴串行：橱柜卡显示衣柜的图，肉眼很难发现，这条能直接拦住。
  for (const category of CASE_CATEGORIES) {
    if (category.cover === null) continue
    assert.equal(
      category.cover,
      `/cases/${category.id}.webp`,
      `${category.name} 的封面文件名与 id 不一致`,
    )
  }
})

test('每个品类都有案例，或明确标注为「靠上传填充」', () => {
  // 与上一轮的断言方向相反：那时钉的是「cases 必须为空」，后来是「必须不空」。
  // 现在多一档：允许某一格先只有封面，但必须是**显式登记过**的那一格（见
  // `UPLOAD_ONLY_CATEGORY_IDS`）。不登记就留空会红，登记了却偷偷配了静态案例也会红。
  //
  // **例外集合本身要先查。** 里面某个 id 拼错时，豁免对那一格静默失效，报出来的错是
  // 「特殊工艺 没有案例」—— 看起来像清单漏配，实际是这行拼错了。把这项前置，诊断信息
  // 才落在真因上。
  for (const id of UPLOAD_ONLY_CATEGORY_IDS) {
    assert.ok(
      CASE_CATEGORIES.some((category) => category.id === id),
      `例外集合里的 ${id} 不在品类清单里`,
    )
  }

  for (const category of CASE_CATEGORIES) {
    if (UPLOAD_ONLY_CATEGORY_IDS.has(category.id)) {
      assert.equal(
        category.cases.length,
        0,
        `${category.name} 已标注为靠上传填充，却又配了静态案例，请把它从例外集合里删掉`,
      )
      // 空品类在界面上会连占位图都没有。有封面才谈得上「点进去自己传」，
      // 否则用户看到的是两层空白。
      assert.notEqual(category.cover, null, `${category.name} 没有封面，用户进来会看到两层空白`)
      continue
    }
    assert.ok(category.cases.length > 0, `${category.name} 没有案例`)
    for (const slot of category.cases) {
      assert.ok(slot.id.startsWith(`${category.id}-`), `${slot.id} 的 id 前缀与品类不符`)
      assert.equal(slot.categoryId, category.id, `${slot.id} 的 categoryId 与所在品类不符`)
      assert.notEqual(slot.cover, null, `${slot.id} 没有封面地址`)
      assertImageFile(slot.cover)
    }
  }
})

test('案例文件名与案例 id 一一对应', () => {
  for (const category of CASE_CATEGORIES) {
    for (const slot of category.cases) {
      assert.equal(
        slot.cover,
        `/cases/album/${slot.id}.webp`,
        `${slot.id} 的图片文件名与 id 不一致`,
      )
    }
  }
})

test('磁盘上没有清单之外的孤儿图', () => {
  const listed = new Set(
    CASE_CATEGORIES.flatMap((category) => category.cases.map((slot) => `${slot.id}.webp`)),
  )
  const onDisk = readdirSync(ALBUM_DIR).filter((name) => name.endsWith('.webp'))

  // 先卡住「目录不是空的」，否则两边都空时下面照样通过。
  assert.ok(onDisk.length > 0, 'album 目录里一张图都没有，这条断言等于没测')

  const orphans = onDisk.filter((name) => !listed.has(name))
  assert.deepEqual(orphans, [], `album 目录里有清单之外的图：${orphans.join('、')}`)

  const missing = [...listed].filter((name) => !onDisk.includes(name))
  assert.deepEqual(missing, [], `清单里有图但磁盘上没有：${missing.join('、')}`)
})

test('name 没有前后空白', () => {
  for (const category of CASE_CATEGORIES) {
    assert.equal(category.name, category.name.trim(), `${category.name} 有前后空白`)
    assert.equal(category.name.length, [...category.name].length, `${category.name} 含隐式字符`)
  }
})

test('反例：校验函数能识别不存在的图片文件', () => {
  // 格式合法但文件不存在。这条确认 `statSync` 那条分支真的会报错，
  // 而不是因为路径拼接错误一直在读同一个存在的文件。
  assert.throws(() => assertImageFile('/cases/not-exist.webp'), /图片文件不存在/)
  assert.throws(() => assertImageFile('/cases/album/not-exist.webp'), /图片文件不存在/)
})

test('反例：校验函数能拒绝非 WebP 与目录穿越写法', () => {
  assert.throws(() => assertImageFile('/cases/foo.jpg'), /图片地址格式不对/)
  assert.throws(() => assertImageFile('../../package.json'), /图片地址格式不对/)
  assert.throws(() => assertImageFile('/cases/../package.json'), /图片地址格式不对/)
  assert.throws(() => assertImageFile(''), /图片地址格式不对/)
})
