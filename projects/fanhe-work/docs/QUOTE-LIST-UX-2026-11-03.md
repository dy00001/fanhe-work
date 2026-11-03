# 维护台三件小事：图格入口、表头固定、拖动排序（2026-11-03）

> 范围：`价格与产品维护` 的三屏（分类 / 产品与价格 / 主类管理）。
> 对应提交：`feat(报价)` 与 `docs(报价)` 两笔，代码与文档分开。

这一轮改的是三件「做错了不报错」的事：图格看着正常但点不动、表头滚走了没人上报、
拖动顺序存了但差一位。所以每一条都配了能变红的断言，见第六节。

---

## 一、产品行的图格：有图没图都是入口

**位置**：产品与价格 → 列表第 3 列（「图」）。

- 整格是一个 `<button>`，32×32，有图显示缩略图，没图显示虚线框 + 加号（原来是一个
  横杠「—」，那看起来像「这里什么都没有、也不会有」）。
- 悬停浮一层半透明遮罩 + 加号图标，点开**行内展开**一条面板，不弹浮层。
- 面板里有三件事：
  - **新增图片 / 更换图片**（同一个按钮，按当前有没有图换文案）；
  - **删除图片**（两次点击：第一次变成「确认删除图片」）；
  - **收起**。

**为什么选完就上传、没有「保存」按钮**：一条产品只有一张主图（`quote_items.image_key`
是一个字段），换图是一次替换而不是编辑一个列表。多一个保存步骤，就会有人选完图直接
收起面板、以为已经传上去了 —— 而界面上什么都没发生，也不报错。

**为什么是行内展开而不是 Popover**：这一格在表格里、表格又在滚动容器里，浮层会被裁掉
或跟着滚错位；Radix Popover 还要多一层 portal，11-03 那次「点图片把整个面板关了」正是
层级问题。行内展开只多一行 DOM，与「改价」是同一个形状。

**接口一行没改**：`POST /api/quote/items/:code/image`（上传 / 替换）与
`DELETE /api/quote/items/:code/image`（解绑）都是既有路由，判权、审计、版本号全部沿用。
所以「有图能不能换」这件事本来就能做，缺的只是一个能点的入口。

**涉及文件**

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/components/quote/maint/QuoteProductManager.tsx` | 图格改按钮、新增 `ProductImageEditor`、`replaceImage` / `clearImage`、`ProductThumb` 占位改图标 |
| `apps/web/src/lib/quote-image.ts` | 未改（复用同一套压缩与失败提示） |
| `apps/api/src/routes/quote.ts` | 未改（复用两条既有路由） |

---

## 二、三个列表的表头首行固定

**位置**：分类列表、产品与价格列表、主类管理表格。

做法：表头的 `<th>` 加 `sticky top-0 z-10 bg-background`，粘在各自滚动容器的顶端。

- **必须自带不透明底色**：不加 `bg-background` 的话，滚上来的行会从表头底下透出来，
  看起来像重影。
- **底边不能再用 `border-b`**：表格是 `border-collapse: collapse`，粘性表头的边框由
  表格自己绘制、会跟着内容一起滚走 —— 滚到中间时表头与第一行之间就没有分隔线了。
  改成 `[box-shadow:inset_0_-1px_0_0_var(--border-soft)]`：1px 内阴影，不动布局、不随
  内容滚动。
- **不遮挡内容**：`z-10` 只压在表格行之上（行里没有定位元素），不会盖住「改价 / 图片」
  展开出来的那一行 —— 那些行是 `<tr>`，在表头之后绘制。

### 🔴 一个必须记下来的坑：Tailwind v4 会静默丢弃 `shadow-[inset ...]`

第一版写的是 `shadow-[inset_0_-1px_0_0_var(--border-soft)]`。源码里有这个字符串、
typecheck 与 lint 全绿、`vite build` 也成功 —— 但产物 CSS 里**没有这条规则**，
界面上就是「什么都没有」。同一份 CSS 里 `shadow-[0_30px_80px_rgb(...)]` 是在的，
所以不是扫描问题，是 `shadow-[...]` 的任意值里带 `inset` 关键字被整条丢掉
（v4 把 inset 阴影拆去了 `inset-shadow-*`）。

判据：构建后 grep 产物 CSS。

```
grep -o "inset 0 -1px 0 0 var(--border-soft)" dist/assets/*.css   # 必须是 1
```

现在统一写成**任意属性**形式：`[box-shadow:inset_0_-1px_0_0_var(--border-soft)]`。
源码断言里也加了「不许再出现 `shadow-[inset`」这一条，理由写在测试里。

**涉及文件**：三个组件里各自的局部 `Th`（没有动 `components/ui/` 的公共组件）。

---

## 三、三个列表支持拖动排序

**手势**：每行左侧新增一个手柄（`GripVertical`），按住拖动；落点在目标行的**上半**插到
它前面、**下半**插到它后面（鼠标位置按行半高判，不用固定像素 —— 产品行有两行文字）。

- 拖着的行半透明；落点行用 `td` 的 inset 阴影画一条 2px 的线（不用行边框，那会让悬停
  那一行突然高 2px，列表跟着抖）。
- 原地松手不发请求（`sameOrder` 拦掉）。
- 拖动失败会**重取列表**：本端是先改顺序再发请求，失败还停在没落库的顺序上，下次打开
  就变回去了，而当时看不出任何异常。

### 分类 / 主类

- 分类：发**完整顺序**（该主类下全部分类名），沿用既有的 `PUT /api/quote/categories/order`。
  上下箭头**保留**（HTML5 拖放没有键盘通道，箭头是原生按钮、读屏与键盘都能用）。
- 主类：新增 `PUT /api/quote/sources/order`，body 是**全部**主类 code 的顺序；发来的数量
  与库里不一致就整批拒绝（400），因为少一个意味着有人的页签会消失。

### 产品：数据结构有一处新增

产品列表一屏只显示前 200 条（五金 596 条），所以契约是「**这一屏的新顺序**」而不是
完整顺序：

```
新顺序 = 发来的 order + （该主类下没提到的行，保持原相对次序）
```

服务端拿这条规则整段重写下标。**只给提到的行写 0..k-1 是不行的**：没提到的 396 行
`sort_order` 还是 0，会跟第 0 名撞在一起，整张列表的顺序立刻散掉。

**新增列**：`quote_items.sort_order`（`INTEGER NOT NULL DEFAULT 0`），迁移
`20261103180000_add_quote_item_sort_order`，另加索引 `(source, sort_order)`。

影响范围（这一处是本次唯一的库结构改动）：

1. **老数据零变化**：1225 行全是默认 0，排序键退化成 `(sort_order, ledger_no, code)`，
   第二键仍是条目号 —— 与加列之前逐行一致。只有真被拖过的行才会拿到 1、2、3…。
2. **`searchItems` 的排序键多了一段**：`[{sortOrder}, {ledgerNo}, {code}]`。查价面板与
   维护台共用这一条查询，所以查价结果也会跟随人工顺序 —— 同一个主类只有一份顺序，
   两处不一致才是更糟的结果。
3. **条目号 `ledger_no` 不动**：它印在报价单上、要跟纸质台账对号，不能拿它当顺序键。
4. **不写审计、不 bump 数据集版本**：版本号的语义是「你手里的价格还成不成立」，让它跟着
   排序变，等于每拖一下其他端都要重拉 1225 条。分类重排也出于同一理由不 bump。
5. **搜索状态下不能拖**（手柄禁用 + 文案说明）：拖的是筛选出来的一小撮，写下去的却是
   整份顺序，会把没显示的几百条整体挪位。
6. **新增 / 导入的产品排在最后**：`sort_order` 默认是 0，而拖过的列表是 1、2、3…，
   新行不写这一列就会顶在第 0 位 —— 看起来像加错了地方，想挪走还得先找到它。
   - 手填新增：写 `max(sort_order)+1`（`nextItemSortOrder`），恢复一条已下架的行同理；
   - 批量导入：只加在 **create** 上（`sortBase + 行序`），**不能**放进 `data` ——
     那个对象同时用于 `update`，放进去等于每次导入都把已有行的顺序清一遍。
     与 `imageKey` 不在更新字段里是同一条道理。

**涉及文件**

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/quote.ts` | `ReorderQuoteItemsRequest`、`ReorderQuoteSourcesRequest` |
| `apps/api/prisma/schema.prisma` + 迁移 | `QuoteItem.sortOrder` + 索引 |
| `apps/api/src/quote/item-order.ts` | 新增：产品重排（含「没提到的接在后面」） |
| `apps/api/src/quote/store.ts` | 新增 `nextItemSortOrder`：手填新增取 max+1；导入只写 create |
| `apps/api/src/quote/sources.ts` | 新增 `reorderSources`，`SourceFailure` 加 `invalid_order` |
| `apps/api/src/quote/store.ts` | `searchItems` 的 `orderBy` 加 `sortOrder` |
| `apps/api/src/routes/quote.ts` | `PUT /items/order`、`PUT /sources/order` + schema + 失败映射 |
| `apps/web/src/lib/api.ts`、`lib/quote.ts` | 两条请求函数 |
| `apps/web/src/lib/quote-sort.ts` | 新增：`applyDrop` / `isAfterMidpoint` / `sameOrder`（纯函数） |
| `apps/web/src/components/quote/maint/use-row-drag.ts` | 新增：三个列表共用的拖动接线 |
| `apps/web/src/components/quote/maint/RowDragHandle.tsx` | 新增：手柄 |
| 三个列表组件 | 接手柄、落点、乐观更新、colSpan（产品 8 / 分类 7 列） |

**没有动的公共组件**：`components/ui/*` 一行未改；`Th` / `Td` 仍是三个组件里各自的局部
函数。产品与分类的列表结构分叉（列不同、展开行不同），抽一个公共表格组件反而会把
「哪一列能拖」这类信息藏起来。

---

## 四、边界与不变的行为

- 一条产品仍然只有一张主图；不支持多图与排序（底层是单个 `image_key`）。
- 删图只清指向，不物理删字节：历史报价仍能看到当时那张。
- 删除产品时，图只在 `image_key === code` 且不是族键时才删 —— 这段没动。
- 下架 / 上架、改价、合并、删分类、删产品、批量导入、变更记录：全部未改。
- 拖动只在「有写权限且列表 > 1 行」时可用；口令失效时手柄置灰。
- 主类拖动后，顶部页签与两个屏的页签同时跟随（同一个 `sortOrder`）。

---

## 五、验证

**门禁**（`projects/fanhe-work` 下，顺序 test → lint → typecheck → format:check）

```
packages/shared  194 项 0 失败
apps/web         496 项 0 失败
apps/desktop     314 项 0 失败
apps/api         464 项 0 失败（5 项设计性跳过）
合计            1468 项 0 失败
lint / typecheck / format:check 全 0
```

新增用例：`apps/web/test/quote-sort.test.mjs`（6 条，纯函数行为）、
`apps/web/test/quote-list-affordance.test.mjs`（5 条，接线与列数）、
`apps/api/test/quote.test.ts`（4 条，排序接口；其中一条顺带钉住「拖过之后新增的产品
排最后」，注入「新增不写 sortOrder」会红）。

**反例注入 8 次，全部如期变红**

| 注入 | 结果 |
| --- | --- |
| `applyDrop` 去掉「插入位左移一格」 | quote-sort 红 |
| 产品表头去掉 `sticky top-0` | affordance 红 |
| 产品展开行 `colSpan={8}` → `{7}` | affordance 红 |
| `canDrag` 去掉 `debounced === ''` | affordance 红 |
| 无图格的 aria-label 退化成常量 | affordance 红 |
| `dragstart` 去掉 `setData` | affordance 红 |
| `item-order` 的 `[...codes, ...rest]` → `[...codes]` | api 红 |
| 主类重排去掉「数量必须一致」 | api 红 |

**产物核对**（这条是必须做的：源码绿 ≠ 界面对）

```
PUT /api/quote/items/order   -> 400   （不存在的路径对照 404）
PUT /api/quote/sources/order -> 400
CSS 里 inset 0 -1px 0 0 var(--border-soft)  -> 1
CSS 里 inset 0 2px 0 0 var(--primary)       -> 1
CSS 里 inset 0 -2px 0 0 var(--primary)      -> 1
JS 里「按住左侧手柄可拖动排序」「搜索状态下不能拖动排序」「确认删除图片」 -> 各 1
库：quote_items.sort_order = integer default 0；_prisma_migrations = 20
```

---

## 六、浏览器里还要看一眼的

这几项只有真人点得出来（本机的维护口令在用户手里，测试不代跑重置）：

1. 产品列表滚动，表头是否一直贴在顶部、且不挡住第一行；
2. 点无图的图格 → 新增一张 → 缩略图就地变；
3. 有图的图格 → 更换 → 缩略图变；删除 → 两次点击 → 变虚线框；
4. 三个列表各拖一次，松手后顺序是否就地更新、刷新后是否还在；
5. 搜索框里打字后，手柄是否按不动并给出那句说明。
