/**
 * 弹窗定位的静态断言。
 *
 * 2026-10-30 的真实故障：给 `DialogContent` 的 className 加了 `relative`，本意是给拖拽
 * 遮罩做一个定位祖先。`cn` 底下的 tailwind-merge 把 `relative` 与基类的 `fixed` 归为
 * 同一组（position），基类的 `fixed` 被删掉，而基类残留的 `translate-x-[-50%]`
 * `translate-y-[-50%]` 还在，面板被推出视口，用户点开任意品类只看得到一层遮罩。
 *
 * 这类故障代价极高（整个品类页打不开），而 lint、typecheck、单元测试全拦不住：它不产生
 * 类型错误，也不改变任何纯函数的输出。所以在这里钉一条静态断言。
 *
 * 判据是「本文件里不该出现 relative 这个词」。`fixed` 本身就是 positioned 元素，
 * `absolute inset-0` 的遮罩与放大层不需要 `relative` 祖先。将来真需要时，先想清楚是不是
 * 在覆盖基类，再决定要不要放宽这条断言。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE_PATH = new URL('../src/components/home/CaseLibraryDialog.tsx', import.meta.url)

/** 注释里可以讨论 `relative`，只有落在代码里的才算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('弹窗的定位类没有被调用处覆盖', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))

  assert.ok(
    !/\brelative\b/.test(code),
    'CaseLibraryDialog.tsx 里出现了 relative。它会覆盖 DialogContent 基类的 fixed，' +
      '把弹窗拽回文档流并推出视口。若确实需要定位祖先，改基类或换容器。',
  )
})

test('弹窗内容层仍然依赖基类的 fixed 定位', () => {
  // 上一条断言是「不该有 relative」，这一条是它的正向对照：确认我们读的确实是那个文件，
  // 且它确实在给 DialogContent 传 className。少了它，上一条在文件被改名或清空时会假绿。
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  assert.ok(code.includes('<DialogContent'), '没找到 DialogContent，断言的前提不成立')
  assert.ok(code.includes('flex flex-col gap-0 p-0'), '没找到预期的布局类，断言的前提不成立')
})
