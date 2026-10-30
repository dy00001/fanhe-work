/**
 * 文件选择器取值顺序的静态断言。
 *
 * 2026-10-30 的真实故障：点「上传图片」选完文件，什么都没发生，也没有任何提示。
 * 拖拽上传却是好的。
 *
 * 根因是取值顺序。`input.files` 返回的 FileList **不是快照**，它与 input 的选中项绑在
 * 一起：把 `value` 置空会连带清空选中项。原来的写法是先拿引用、再清空、再判断长度 ——
 * 拿到手里的那个 FileList 在下一行就空了，`addFiles` 第一句 `if (files.length === 0) return`
 * 直接返回。于是整条链路静默终止。
 *
 * 这类故障 lint、typecheck、单元测试全拦不住：没有类型错误，没有异常，纯函数的输出也不变。
 * 只有真人点一次按钮才会暴露。所以钉一条静态断言在这里。
 *
 * 判据：`Array.from(event.target.files ...)` 的位置必须早于 `event.target.value = ''`。
 *
 * 这里**不做全局注释剥离**。该文件里存在 `accept="image/*"`，它的开头两字符会被朴素的
 * 块注释正则当成注释起始，一路吃到下一个星号斜杠，把夹在中间的 `onChange` 一起删掉 ——
 * 断言就会报「没找到 onChange」这种假失败（这个坑在本文件第一版就踩过一次）。改为在
 * `type="file"` 之后的定长窗口里做定位，并额外断言参与比较的两个字面量在该窗口内唯一。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE_PATH = new URL('../src/components/home/CaseLibraryDialog.tsx', import.meta.url)

/** 从文件选择器的 `type="file"` 往后取一段，覆盖整个 `<input>` 到它的 onChange 回调。 */
function inputWindow(source) {
  const anchor = source.indexOf('type="file"')
  assert.ok(anchor !== -1, '没找到 type="file"，断言的前提不成立')
  return source.slice(anchor, anchor + 1200)
}

function countOccurrences(haystack, needle) {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

test('文件选择器先把 FileList 拷成数组，再清空 value', () => {
  const source = readFileSync(SOURCE_PATH, 'utf8')
  const block = inputWindow(source)

  const snapshotToken = 'Array.from(event.target.files'
  const clearToken = "event.target.value = ''"

  // 唯一性保护：注释里若出现同样的字面量，位置比较就不再代表代码顺序。
  assert.equal(
    countOccurrences(block, clearToken),
    1,
    `"${clearToken}" 在文件选择器窗口内出现了不止一次（可能写进了注释），` +
      '位置比较将不再代表代码顺序，请改写注释措辞。',
  )

  const snapshot = block.indexOf(snapshotToken)
  const clear = block.indexOf(clearToken)

  assert.ok(snapshot !== -1, 'onChange 里没有把 FileList 拷成数组')
  assert.ok(clear !== -1, 'onChange 里没有清空 value，重选同一张图片将不再触发 change')
  assert.ok(
    snapshot < clear,
    '必须先快照再清空。反过来的话 value 置空会连带清空 FileList，' +
      'addFiles 拿到长度为 0 的列表后直接返回 —— 表现就是「选了图片没有任何反应」。',
  )
})

test('上传入口确实是一个接受多选的文件输入', () => {
  // 上一条是「顺序要对」，这一条是它的前提：确认我们读的确实是那个带文件选择器的文件。
  const source = readFileSync(SOURCE_PATH, 'utf8')
  assert.ok(source.includes('type="file"'), '没找到 type="file"，断言的前提不成立')
  assert.ok(source.includes('accept="image/*"'), '文件选择器没有限定图片类型')
  assert.ok(source.includes('multiple'), '文件选择器不支持多选')
})

test('addFiles 只接受数组，不接受活引用', () => {
  // 入参类型写成 FileList 时，调用方可以继续传一个会被清空的活引用，bug 就会重新长出来。
  const source = readFileSync(SOURCE_PATH, 'utf8')
  assert.ok(
    source.includes('addFiles(files: readonly File[])'),
    'addFiles 的入参应该限定为 readonly File[]，避免再次传入 FileList',
  )
})
