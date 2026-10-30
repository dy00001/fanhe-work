# 千牛（qianniu）

`tb qianniu` —— 读卖家中心（myseller.taobao.com）的只读数据，走浏览器插件桥，用你浏览器里
已登录的千牛身份。安装/登录态说明见 `SKILL.md`（五个工具共用一个插件）。

本模块由「梵禾 Work」自建（厂商交付包里没有千牛模块，`tb modules` 里只有生意参谋和万相台），
接口是在真实登录态下逐个实测出来的，下面标注了每一项的实测日期。

## 命令

| 命令 | 取到什么 | 实测 |
|---|---|---|
| `doctor` | 登录态、MTOP 令牌、三个接口各打一枪 | 2026-10-30 ✓ |
| `review-pending` | **待商家回复的评价**：总数 + 列表（日期/买家/星级/正文/商品） | 2026-10-30 ✓ 48 条 |
| `ask-pending` | **问大家待回答**：总数、已答数、待回答列表 | 2026-10-30 ✓ 104 条里 16 条待答 |
| `refund-overview` | 退款/售后的待处理单量（全部、24h 内、退款待处理、待收货、待举证…） | 2026-10-30 ✓ |
| `api` | 通用只读直通：给任何 MTOP api 传参，原样打印 | — |

```bash
scripts\qianniu.cmd doctor
scripts\qianniu.cmd review-pending --limit 10
scripts\qianniu.cmd ask-pending --limit 10
scripts\qianniu.cmd refund-overview
```

`ask-pending` 比别的贵：平台的 api **没有「只看未答」的筛选项**（传 `hasAnswer` 会被无声忽略），
只能翻页自己数，104 条 = 6 次请求。

## 三个坑（都在实测里踩过）

1. **参数包装不统一，写错不报错。** 同一个网关下：
   - `mtop.rm.sellercenter.list.data.pc` → `{"jsonBody": "{...}"}`
   - `mtop.rm.sellercenter.ask.list` → `{"jsonBody": "{...}"}`
   - 退款那一族 → `{"params": "{...}"}`

   写错包装时平台照回 `SUCCESS`，但只给一个空壳：`{"pageConfig":…,"pagination":{"pageSize":10,"current":1}}`
   —— 没有 `total`、没有 `dataSource`，pageSize 还是默认值 10。判断依据就是**分页段里的 pageSize
   是不是你传的值**。`cli.py` 里每个命令都查 `total` 在不在，不在就报「回包是空壳」，不让它冒充「这项是 0」。

2. **`mtop.taobao.rate.detaillist.get` 是买家侧单商品评价**，要 `auctionNumId`。卖家侧的「待回复评价」
   走 `mtop.rm.sellercenter.list.data.pc` + `pageType=rateWait4PC`，两者别混。

3. **问大家的 `hasAnswer` 参数无效**。传 0 和 1 回的是同一批（`searchParams` 里也没有对应条件），
   因此待回答数只能翻页按行里的 `hasAnswer` 数。别信「传 0 就直接是待答列表」。

## 还没接的（接口未知，别照猜）

- **商品基础分 / 扶优分**（商品诊断）：`mtop.taobao.sell.pc.manage.async` 需要正确的 `url` 参数，
  实测传 `/tmall/manager/table.htm?tab=all` 回「无效请求url」，正确的页面路径还没拿到。
- **服务保障状态**（商家保障中心）、**物流履约指标**：另一套接口（可能走插件放行的
  `ascp-plan-control-tower-web.dchain-api-proxy.taobao.com/data/lg/`），路径未知。
- **千牛公告 / 店铺信息**：未探。

要补：在已登录的浏览器里打开那一页，用开发者工具看它的 XHR 请求名，然后

```bash
scripts\qianniu.cmd api <mtop.api.name> --v 1.0 --json-body '{"...":"..."}'
```

能直接验证。**不要凭名字猜**：MTOP 对不存在的 api 回 `FAIL_SYS_API_NOT_FOUNDED`，对存在但参数错的
回 `FAIL_SYS_BIZPARAM_MISSED::缺少业务参数xxx` —— 后者明确告诉你缺哪个参数，比在生意参谋里盲猜路径可靠得多。

## 落盘格式（`--raw --out <文件>`）

```json
{
  "total": 48,
  "account": { "nick": "梵禾定制家具:小阳", "uid": "3965512335" },
  "collectedAt": "2026-10-30T16:00:49",
  "rows": [ ... ]
}
```

`ask-pending` 多一个 `pending` 字段（待答条数），`total` 是问大家总数。

**`account` 不是为了好看，是为了事后能判串店。** 千牛接口只认「浏览器里现在登录的是谁」，
不认调用方以为是谁；多店采集是一个循环里逐店切账号，切失败时甲店的数会顶着乙店的名字
入库且不报错。采集侧的 `export-sycm-ingest.mjs` 拿这个 `nick` 与槽位的 `pluginAccount`
逐字比对，对不上就丢弃。**删掉这个字段等于把串店保护一起删掉。**

`collectedAt` 同理：这两个数是**采集那一刻的快照**，不是「那一天的历史」。导出侧只允许
「今天 / 昨天」两个窗口（日常那一轮采的是 T-1），回填更早的日期整块跳过，见
`appendQianniu` 里的注释。

## 只读护栏

- `write_re` 与插件 `background.js` 里千牛那一项的 `WRITE` **逐字一致**：路径里出现
  update/create/delete/save/send/post/set/pay/refund 等动词一律拒绝。改一边必须改另一边。
- 退款统计那三个接口名字里带 `refund`，是退款管理页自己的读接口，逐个登记在
  `Platform.read_allow` 与插件的 `READS` 里（两处也必须一致）。
- 插件只放行 `h5api.m.taobao.com/h5/`：**页面 HTML 拿不到**，只有 MTOP。
