/**
 * 删除按钮「只对上传图有效」这个旧缺陷的钉子。
 *
 * 2026-11-03 反馈：「每个品类下已有图片无法删除，新上传的图片可以删除」。根因不在权限
 * 判断，而在这一层的**删除能力被绑到了图片来源上**：
 *
 *     const deletableCount =
 *       selectedItems.filter((item) => uploadIds.has(item.id)).length
 *
 * `uploadIds` 只包含 `case_uploads` 里的行，内置图（`cabinet-1`）永远不在其中。于是
 * 选中已有图片时 `deletableCount === 0`，删除按钮整个是灰的；即使点得到，服务端也只认
 * 上传图，进来就是 404。
 *
 * 修法有两半：服务端给内置图一个「已移除」的表示（`DELETE /api/cases/items/:itemId`），
 * 前端把删除条件改回「选中的张数」。服务端那一半由 `apps/api/test/case-library.test.ts`
 * 钉住，这里钉前端这一半 —— 它不产生类型错误，单测也测不到（按钮的 disabled 只有在
 * 浏览器里点一次才看得见）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const DIALOG_PATH = new URL('../src/components/home/CaseLibraryDialog.tsx', import.meta.url)

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 取一行赋值语句（含折行的写法），用来检查它依赖了什么。 */
function assignmentOf(code, name) {
  const pattern = new RegExp(
    `const ${name} =([\\s\\S]*?)(?=\\n\\s*(?:\\/\\*|const|function|return|\\}))`,
  )
  const match = pattern.exec(code)
  assert.ok(match !== null, `没找到 ${name} 的赋值，断言的前提不成立`)
  return match[1]
}

test('可删除张数就是选中的张数，不再按图片来源筛', () => {
  const code = stripComments(readFileSync(DIALOG_PATH, 'utf8'))
  const assignment = assignmentOf(code, 'deletableCount')

  assert.ok(
    assignment.includes('selectedItems.length'),
    `deletableCount 已经不是「选中的张数」：${assignment.trim()}。` +
      '按来源筛会出现「选中已有图片时删除按钮是灰的」这个原样复发的缺陷。',
  )
  assert.ok(
    !assignment.includes('uploadIds'),
    `deletableCount 又依赖 uploadIds 了：${assignment.trim()}。` +
      'uploadIds 只含上传图，内置图永远不在里面 —— 这正是「已有图片删不掉」的根因。',
  )
})

test('删除按钮的禁用条件只看张数与保存中，不看来源', () => {
  const code = stripComments(readFileSync(DIALOG_PATH, 'utf8'))
  const disabled = /disabled=\{([^}]*deletableCount[^}]*)\}/.exec(code)
  assert.ok(disabled !== null, '没找到删除按钮的 disabled 条件，断言的前提不成立')
  assert.ok(
    !disabled[1].includes('uploadIds'),
    `disabled 条件里出现了 uploadIds：${disabled[1]}。它会永久禁用内置图的删除。`,
  )
})

test('删除走统一的 deleteItem，不再有 upload 专用的调用', () => {
  const code = stripComments(readFileSync(DIALOG_PATH, 'utf8'))
  assert.ok(
    code.includes('library.deleteItem('),
    '没找到 library.deleteItem 调用。删除必须走统一入口，否则内置图会被前端直接跳过。',
  )
  assert.ok(
    !code.includes('library.deleteUpload('),
    '还在调 library.deleteUpload。那条路径只认上传图，内置图会被静默跳过（旧缺陷）。',
  )
  assert.ok(
    !code.includes('removeUploads('),
    '还在用 removeUploads（只删上传图）。名字与行为都要跟着统一。',
  )
})
