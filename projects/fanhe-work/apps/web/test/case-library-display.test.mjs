/**
 * 案例库展示规则的测试。
 *
 * 这一层的错误全都「看起来没问题」：一张图被算进了两个文件夹、一张已经删掉文件夹的图
 * 从界面上消失、筛选到空文件夹却显示全部…… 它们在浏览器里都能靠点几下发现，但没人
 * 每次改代码都点一遍。所以把规则抽成纯函数放在这里钉住。
 *
 * 快照的形状直接抄服务端的响应（`{ revision, folders, placements }`），不经过任何
 * 转换层 —— 测的是「服务端给的东西，界面读出来的结果对不对」。
 *
 * 2026-10-29 起多了一组规则：**跨品类移动**。图片可以被挪进任何品类的文件夹，因此
 * 视图要同时处理「本品类的图被挪走了」与「别的品类的图被挪进来」两个方向。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CASE_CATEGORIES, caseCoverItemId } from '../src/lib/case-catalog.ts'
import {
  applyMoveToSnapshot,
  buildCaseIndex,
  buildCaseLibraryView,
  filterCaseItems,
  filterKey,
  groupFoldersByCategory,
} from '../src/lib/case-library-display.ts'

/** 全量清单的索引，与组件里那份同源。建一次就够。 */
const INDEX = buildCaseIndex(CASE_CATEGORIES)

function categoryOf(id) {
  const found = CASE_CATEGORIES.find((item) => item.id === id)
  assert.ok(found !== undefined, `清单里没有品类 ${id}`)
  return found
}

function folder(id, categoryId, name) {
  return {
    id,
    categoryId,
    name,
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  }
}

const EMPTY = { revision: 1, folders: [], placements: [] }

test('未归档包含全部图片，封面排第一', () => {
  const category = categoryOf('cabinet')
  const view = buildCaseLibraryView(category, EMPTY, INDEX)

  assert.equal(view.all.length, category.cases.length + 1)
  assert.equal(view.all[0].id, caseCoverItemId('cabinet'))
  assert.equal(view.unassigned.length, view.all.length)
  assert.equal(view.folders.length, 0)
})

test('归属关系按文件夹分组，只算本品类的文件夹', () => {
  const category = categoryOf('cabinet')
  const snapshot = {
    revision: 2,
    folders: [
      folder('f1', 'cabinet', '主卧灰玻'),
      folder('f2', 'cabinet', '儿童房'),
      // 另一个品类的文件夹不该出现在橱柜的图集里。
      folder('f3', 'wardrobe', '主卧'),
    ],
    placements: [
      { itemId: 'cabinet-1', folderId: 'f1' },
      { itemId: 'cabinet-2', folderId: 'f1' },
      { itemId: 'cabinet-3', folderId: 'f2' },
      // 被挪进了衣柜的文件夹 —— 对这个品类来说就是「移走了」。
      { itemId: 'cabinet-4', folderId: 'f3' },
    ],
  }
  const view = buildCaseLibraryView(category, snapshot, INDEX)

  assert.deepEqual(
    view.folders.map((group) => [group.folder.name, group.items.map((item) => item.id)]),
    [
      ['主卧灰玻', ['cabinet-1', 'cabinet-2']],
      ['儿童房', ['cabinet-3']],
    ],
  )
  // 反向：cabinet-4 去了衣柜，橱柜这边就不该再有它（既不在文件夹里，也不在未归档里）。
  assert.equal(
    view.all.some((item) => item.id === 'cabinet-4'),
    false,
  )
  assert.deepEqual(
    view.unassigned.map((item) => item.id),
    [caseCoverItemId('cabinet')],
  )
  // 封面 + 3 张留下的。
  assert.equal(view.all.length, 4)
})

test('跨品类移动：在目标品类的文件夹里出现，带自己的地址与标题', () => {
  const snapshot = {
    revision: 6,
    folders: [folder('fc', 'cabinet', '主卧灰玻'), folder('fw', 'wardrobe', '长衣区')],
    placements: [{ itemId: 'cabinet-1', folderId: 'fw' }],
  }

  const wardrobeView = buildCaseLibraryView(categoryOf('wardrobe'), snapshot, INDEX)
  const group = wardrobeView.folders.find((item) => item.folder.id === 'fw')
  assert.ok(group !== undefined)
  assert.deepEqual(
    group.items.map((item) => item.id),
    ['cabinet-1'],
  )
  // 地址来自全局索引：衣柜的静态清单里没有这张图，只能这么取。
  assert.equal(group.items[0].src, '/cases/album/cabinet-1.webp')
  assert.equal(group.items[0].thumb, '/cases/thumbs/cabinet-1.webp')
  // 标题用**源品类**的名字，不是「衣柜案例 1」—— 那是假的。
  assert.equal(group.items[0].alt, '橱柜案例 1')
  // 计入「全部」（用户切到「全部」时能看见它），但不在未归档里（它有文件夹）。
  assert.equal(
    wardrobeView.all.some((item) => item.id === 'cabinet-1'),
    true,
  )
  assert.equal(
    wardrobeView.unassigned.some((item) => item.id === 'cabinet-1'),
    false,
  )
})

test('外来图排在本品类自有图之后，顺序稳定', () => {
  const snapshot = {
    revision: 8,
    folders: [folder('fw', 'wardrobe', '长衣区')],
    placements: [
      { itemId: 'cabinet-3', folderId: 'fw' },
      { itemId: 'cabinet-2', folderId: 'fw' },
    ],
  }
  const view = buildCaseLibraryView(categoryOf('wardrobe'), snapshot, INDEX)
  const group = view.folders.find((item) => item.folder.id === 'fw')
  assert.ok(group !== undefined)
  // 按全局清单顺序（cabinet-2 在 cabinet-3 之前），不按归属表的返回顺序。
  assert.deepEqual(
    group.items.map((item) => item.id),
    ['cabinet-2', 'cabinet-3'],
  )
  // 本品类自有图在前。
  assert.equal(view.all[0].id, caseCoverItemId('wardrobe'))
})

test('指向已不存在的文件夹的归属，按未归档处理', () => {
  const category = categoryOf('wine-cabinet')
  const view = buildCaseLibraryView(
    category,
    {
      revision: 3,
      folders: [],
      placements: [{ itemId: 'wine-cabinet-1', folderId: 'gone' }],
    },
    INDEX,
  )
  assert.equal(
    view.unassigned.some((item) => item.id === 'wine-cabinet-1'),
    true,
  )
})

test('筛选：三个分支与「文件夹被删后退回全部」', () => {
  const category = categoryOf('cabinet')
  const snapshot = {
    revision: 4,
    folders: [folder('f1', 'cabinet', '主卧灰玻')],
    placements: [{ itemId: 'cabinet-1', folderId: 'f1' }],
  }
  const view = buildCaseLibraryView(category, snapshot, INDEX)

  assert.equal(filterCaseItems(view, { kind: 'all' }).length, view.all.length)
  assert.deepEqual(
    filterCaseItems(view, { kind: 'unassigned' }).map((item) => item.id),
    [caseCoverItemId('cabinet'), 'cabinet-2', 'cabinet-3', 'cabinet-4'],
  )
  assert.deepEqual(
    filterCaseItems(view, { kind: 'folder', folderId: 'f1' }).map((item) => item.id),
    ['cabinet-1'],
  )
  // 反向：筛一个不存在的文件夹时退回全部，而不是给一个空列表 —— 后者看起来像
  // 「这个文件夹里什么都没有」，而事实是「这个文件夹没了」。
  assert.equal(filterCaseItems(view, { kind: 'folder', folderId: 'gone' }).length, view.all.length)
})

test('filterKey 三态互不相等', () => {
  const keys = [
    filterKey({ kind: 'all' }),
    filterKey({ kind: 'unassigned' }),
    filterKey({ kind: 'folder', folderId: 'f1' }),
  ]
  assert.equal(new Set(keys).size, 3)
})

test('乐观移动：移入覆盖旧归属，移出删掉归属行', () => {
  const snapshot = {
    revision: 5,
    folders: [],
    placements: [
      { itemId: 'a', folderId: 'f1' },
      { itemId: 'b', folderId: 'f1' },
      { itemId: 'c', folderId: 'f2' },
    ],
  }

  const moved = applyMoveToSnapshot(snapshot, ['a', 'b'], 'f2')
  assert.deepEqual(
    [...moved.placements].sort((left, right) => left.itemId.localeCompare(right.itemId)),
    [
      { itemId: 'a', folderId: 'f2' },
      { itemId: 'b', folderId: 'f2' },
      { itemId: 'c', folderId: 'f2' },
    ],
  )

  // 移出 = 删除行，而不是写一条 folderId: null。服务端的存储约定是「没有行就是未归档」，
  // 本地多出一条 null 行会让下一次比较与回写都不一致。
  const removed = applyMoveToSnapshot(snapshot, ['a'], null)
  assert.deepEqual(removed.placements.map((placement) => placement.itemId).sort(), ['b', 'c'])

  // 原快照不被改动（纯函数）。
  assert.equal(snapshot.placements.length, 3)
  assert.equal(moved.revision, 5)
})

test('移动菜单：按品类分组、只列有文件夹的品类、张数含外来图', () => {
  const snapshot = {
    revision: 7,
    folders: [folder('fw', 'wardrobe', '长衣区'), folder('fc', 'cabinet', '主卧灰玻')],
    placements: [
      // 橱柜的两张躺在衣柜的文件夹里。
      { itemId: 'cabinet-1', folderId: 'fw' },
      { itemId: 'cabinet-2', folderId: 'fw' },
      { itemId: 'wardrobe-1', folderId: 'fc' },
    ],
  }

  const groups = groupFoldersByCategory(snapshot, CASE_CATEGORIES)
  // 顺序跟品类顺序（橱柜在衣柜之前），而不是跟着文件夹的创建时间。
  assert.deepEqual(
    groups.map((group) => [
      group.categoryName,
      group.folders.map((item) => [item.folder.name, item.count]),
    ]),
    [
      ['橱柜', [['主卧灰玻', 1]]],
      ['衣柜', [['长衣区', 2]]],
    ],
  )
  // 没有文件夹的品类不出现：13 个品类全列出来会是一长串空标题。
  assert.equal(groups.length, 2)
})
