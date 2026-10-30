#!/usr/bin/env python3
"""千牛（卖家中心）只读数据命令：tb qianniu <命令>。

取数路径和另外几个平台一样（见 `tb/core/transport.py`）：走浏览器插件桥，用你浏览器里
已登录的千牛身份；请求、登录判断、风控词、只读护栏都在 `tb/core` 里，这里只放
接口清单、参数拼装和输出。

**所有接口都是 MTOP**（`h5api.m.taobao.com/h5/<api>/<version>/`），签名在 `core/mtop.py`。
三个实测过的接口：

| 命令 | MTOP api | 参数写法 |
|---|---|---|
| `review-pending` | `mtop.rm.sellercenter.list.data.pc` | `{"jsonBody": "{\"pageType\":\"rateWait4PC\",...}"}` |
| `ask-pending` | `mtop.rm.sellercenter.ask.list` | `{"jsonBody": "{\"pagination\":{...},\"bizType\":200}"}` |
| `refund-overview` | `mtop.alibaba.refundface2.disputeservice.qianniu.pc.statistic` | `{"params": "{\"userType\":1}"}` |

**参数包装是这里最容易踩的坑**：同一个网关下，不同 api 对参数的包装方式不一样 ——
有的直接摊在 data 里（`ask.list` 第一次用平铺写法也回数据，但 `hasAnswer` 被无声忽略），
有的必须整串塞进 `jsonBody`，退款那几个必须塞进 `params`。写错包装**不会报错**，
只会返回一个「成功但没有列表」的空壳（`{"pageConfig":…,"pagination":{"pageSize":10}}`，
pageSize 还是默认的 10，一眼能看出参数没进去）。所以每个命令都检查分页段在不在，
不在就按「结构变了」报错，不让空壳冒充「这项是 0」。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime

from ...core import transport
from ...core.auth import NotLoggedIn
from ...core.client import Client
from ...core.errors import ApiFailed, TbError
from .platform import QIANNIU

# ---- 接口清单（api 名, 版本）----
API_RATE_WAIT = ("mtop.rm.sellercenter.list.data.pc", "1.0")
API_ASK = ("mtop.rm.sellercenter.ask.list", "1.0")
API_REFUND_STAT = ("mtop.alibaba.refundface2.disputeservice.qianniu.pc.statistic", "1.0")

# 评价管理页的「待商家回复」标签。换别的标签就是另一个列表：
# rateAllPC=全部、rateWait4PC=待商家回复、rateUnrepliedPC=未回复（没有这个标签，别照猜）。
RATE_PAGE_TYPE = "rateWait4PC"

_CLIENT: Client | None = None


def client() -> Client:
    """一次运行只建一个连接（插件桥一次只服务一个命令行，重复建会排队）。"""
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = transport.make_client(QIANNIU)
    return _CLIENT


def call(api: tuple[str, str], data: dict, *, name: str = "") -> dict:
    """发一次 MTOP 请求，返回完整回包（含 ret）。data 是已经包好壳的参数。"""
    api_name, version = api
    return client().get("gw", f"/{api_name}/{version}/", data, raw=True, name=name or api_name)


# ---------- 参数包装 ----------


def _wrap_json_body(body: dict) -> dict:
    """塞进 jsonBody 的写法（评价列表、问大家都是这个）。"""
    return {"jsonBody": json.dumps(body, ensure_ascii=False, separators=(",", ":"))}


def _wrap_params(body: dict) -> dict:
    """塞进 params 的写法（退款那一族）。"""
    return {"params": json.dumps(body, ensure_ascii=False, separators=(",", ":"))}


def _inner(payload: dict, label: str) -> dict:
    """取回包里的 data.data。取不到说明包装写错了或接口改了，直接报错，别当空数据。"""
    data = payload.get("data")
    inner = data.get("data") if isinstance(data, dict) else None
    if not isinstance(inner, dict):
        raise ApiFailed("回包里没有 data.data，接口结构可能变了。", endpoint=label, stage="数据检查")
    return inner


def _paged(payload: dict, label: str, keys: tuple[str, ...] = ("dataSource",)) -> tuple[dict, list, int]:
    """(pagination, rows, total)。分页段或列表缺一个就报错 —— 空壳回包就是这个形状。"""
    inner = _inner(payload, label)
    pagination = inner.get("pagination")
    if not isinstance(pagination, dict) or "total" not in pagination:
        raise ApiFailed(
            "回包是空壳：没有分页总数。多半是参数没塞进 jsonBody/params，平台当成了空条件。",
            endpoint=label, stage="数据检查",
            hint="改参数包装前先看一眼回包的 pagination.pageSize：不是你要的值就是参数没进去。",
        )
    rows: list = []
    for key in keys:
        got = inner.get(key)
        if isinstance(got, list):
            rows = got
            break
    total = pagination.get("total")
    return pagination, rows, int(total) if isinstance(total, (int, float)) else 0


# ---------- 小工具 ----------


def _date_of(ms) -> str:
    """评价时间是毫秒时间戳。"""
    try:
        return datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d")
    except (TypeError, ValueError, OSError):
        return "—"


def _short(text, width: int) -> str:
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return s if len(s) <= width else s[: width - 1] + "…"


def _pad(text, width: int) -> str:
    """按显示宽度补空格：中文占两格，用 len 补出来的列全是歪的。"""
    s = _short(text, width)
    shown = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in s)
    return s + " " * max(0, width - shown)


def _dump(path: str, payload) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"已写入 {path}")


# ---------- 业务命令 ----------


def rate_wait_page(page: int, size: int) -> tuple[list, int]:
    """待商家回复的评价（一页）。返回 (rows, 总数)。"""
    data = _wrap_json_body({"pageType": RATE_PAGE_TYPE,
                            "pagination": {"current": page, "pageSize": size}})
    payload = call(API_RATE_WAIT, data, name="评价待回复")
    _, rows, total = _paged(payload, "评价待回复")
    return rows, total


def ask_page(page: int, size: int) -> tuple[list, int]:
    """问大家（一页，不分已答未答）。返回 (rows, 总数)。"""
    data = _wrap_json_body({"pagination": {"current": page, "pageSize": size}, "bizType": 200})
    payload = call(API_ASK, data, name="问大家")
    _, rows, total = _paged(payload, "问大家")
    return rows, total


def refund_overview() -> list[dict]:
    """退款概况：平台把两行分组里的格子平铺在 resultData.dataSource[].content 里。"""
    payload = call(API_REFUND_STAT, _wrap_params({"userType": 1}), name="退款概况")
    data = payload.get("data")
    result = data.get("resultData") if isinstance(data, dict) else None
    groups = result.get("dataSource") if isinstance(result, dict) else None
    if not isinstance(groups, list):
        raise ApiFailed("退款概况回包里没有 resultData.dataSource，接口结构可能变了。",
                        endpoint="退款概况", stage="数据检查")
    cells: list[dict] = []
    for group in groups:
        for cell in (group or {}).get("content") or []:
            if isinstance(cell, dict):
                cells.append(cell)
    return cells


def ask_pending(page_size: int, max_pages: int) -> tuple[int, int, list]:
    """翻完问大家，按 hasAnswer 统计。返回 (总数, 待回答数, 待回答的行)。

    平台的 api **没有「只看未答」的筛选项** —— 传 hasAnswer 会被无声忽略（实测传 0 和 1
    回的是同一批），所以只能翻页自己数。这条命令因此比别的贵：104 条问大家 = 6 次请求。
    """
    total, answered, pending_rows = 0, 0, []
    page = 1
    while page <= max_pages:
        rows, total = ask_page(page, page_size)
        for row in rows:
            if row.get("hasAnswer"):
                answered += 1
            else:
                pending_rows.append(row)
        if not rows or page * page_size >= total:
            break
        page += 1
    return total, len(pending_rows), pending_rows


# ---------- 命令 ----------


def cmd_doctor(args) -> None:
    print("千牛 · 自检（只读）")
    tk = None
    try:
        tk = client().cookie("_m_h5_tk")
    except TbError as e:
        print(f"  ✗ MTOP 令牌：{e}")
        return
    print(f"  MTOP 令牌：{'有' if tk else '浏览器里没有这个 cookie'}（没有也能取数：网关按登录态放行）")

    probes = [
        ("评价待回复", lambda: f"{rate_wait_page(1, 1)[1]} 条待商家回复"),
        ("问大家", lambda: f"共 {ask_page(1, 1)[1]} 条（待回答要翻页统计，见 ask-pending）"),
        ("退款概况", lambda: " / ".join(f"{c.get('title')} {c.get('value')}" for c in refund_overview()[:2])),
    ]
    ok = 0
    for name, fn in probes:
        try:
            print(f"  ✓ {name}：{fn()}")
            ok += 1
        except TbError as e:
            print(f"  ✗ {name}：{str(e).splitlines()[0]}")
    account = getattr(getattr(client(), "session", None), "account", None) or {}
    if account:
        print(f"  登录账号：{account.get('nick') or '—'}（{account.get('uid') or '—'}）")
    print(f"\n{ok}/{len(probes)} 项可用。" + ("" if ok == len(probes) else "失败项照提示处理后再跑一次。"))
    if ok == 0:
        raise SystemExit(1)


def cmd_review_pending(args) -> None:
    rows, total = rate_wait_page(1, args.limit)
    print(f"待商家回复的评价：{total} 条")
    if args.raw:
        _dump(args.out or "qianniu-review-pending.json",
              {"total": total, "rows": rows})
        return
    if not rows:
        print("  没有待回复的评价。")
        return
    for row in rows:
        rate = ((row.get("rateContent") or {}).get("mainRate") or {})
        item = (row.get("itemInfo") or {})
        buyer = ((row.get("userInfo") or {}).get("userName")
                 or (row.get("orderInfo") or {}).get("userName") or "—")
        # 这一列**不是星级**。列表里唯一的星级线索是 userStar 那个 gif，而它是买家信用等级
        # （`b_blue_3.gif` = 蓝冠 3 级），拿它当星级会把「非常满意」的 5 星评价显示成 3 星。
        # 平台在这个列表里没给星级，就不猜；要星级得逐商品打 mtop.taobao.rate.detaillist.get。
        print(f"  {_date_of(rate.get('date'))}  {_pad(buyer, 12)}"
              f"{_pad(rate.get('content'), 40)}{_short(item.get('title'), 24)}")
    if total > len(rows):
        print(f"  … 还有 {total - len(rows)} 条，用 --limit {min(total, 50)} 多看一些")


def cmd_ask_pending(args) -> None:
    total, pending, rows = ask_pending(args.page_size, args.max_pages)
    if args.raw:
        _dump(args.out or "qianniu-ask-pending.json",
              {"total": total, "pending": pending, "rows": rows})
        return
    print(f"问大家：共 {total} 条，已答 {total - pending} 条，待回答 {pending} 条")
    if not pending:
        print("  没有待回答的问大家。")
        return
    for row in rows[: args.limit]:
        ask = (row.get("askAndAnswerModule") or {})
        item = (row.get("itemInfo") or {})
        print(f"  {_date_of_iso(ask.get('gmtCreate'))}  {_pad(ask.get('content'), 34)}"
              f"{_short(item.get('title'), 24)}")
    if pending > args.limit:
        print(f"  … 还有 {pending - args.limit} 条，用 --limit {pending} 全部列出")


def _date_of_iso(text) -> str:
    """问大家给的是「2026-10-08 15:45:36」这种字符串，取日期部分。"""
    return str(text or "")[:10] or "—"


def cmd_refund_overview(args) -> None:
    cells = refund_overview()
    if args.raw:
        _dump(args.out or "qianniu-refund-overview.json", cells)
        return
    print("退款/售后概况（待商家处理的单量）")
    for cell in cells:
        warn = " ⚠" if cell.get("warn") else ""
        print(f"  {_pad(cell.get('title') or '—', 16)}{str(cell.get('value') or '0'):>4}{warn}")


def cmd_api(args) -> None:
    """通用只读直通：给以后加功能用的探针。参数要么给 --data（平铺），要么 --json-body / --params。"""
    if sum(bool(x) for x in (args.data, args.json_body, args.params)) > 1:
        raise ValueError("--data / --json-body / --params 只能给一个")
    if args.json_body:
        data = _wrap_json_body(json.loads(args.json_body))
    elif args.params:
        data = _wrap_params(json.loads(args.params))
    else:
        data = json.loads(args.data) if args.data else {}
    payload = call((args.api, args.version), data, name=args.api)
    if args.out:
        _dump(args.out, payload)
        return
    print(json.dumps(payload, ensure_ascii=False, indent=1))


# ---------- 入口 ----------


def _add_output(sub) -> None:
    sub.add_argument("--raw", action="store_true", help="输出原始 JSON（配合 --out）")
    sub.add_argument("--out", help="写到这个文件")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tb qianniu", description="千牛（卖家中心）只读数据命令")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("doctor", help="自检：登录态、MTOP 令牌、三个接口探针")
    s.set_defaults(func=cmd_doctor)

    s = sub.add_parser("review-pending", help="待商家回复的评价（差评巡检的入口）")
    s.add_argument("--limit", type=int, default=5, help="列多少条 (默认 5)")
    _add_output(s)
    s.set_defaults(func=cmd_review_pending)

    s = sub.add_parser("ask-pending", help="问大家待回答数（要翻页统计）")
    s.add_argument("--page-size", type=int, default=20, help="每页条数 (默认 20)")
    s.add_argument("--max-pages", type=int, default=30, help="最多翻几页（防跑飞，默认 30）")
    s.add_argument("--limit", type=int, default=5, help="列多少条 (默认 5)")
    _add_output(s)
    s.set_defaults(func=cmd_ask_pending)

    s = sub.add_parser("refund-overview", help="退款/售后的待处理单量")
    _add_output(s)
    s.set_defaults(func=cmd_refund_overview)

    s = sub.add_parser("api", help="通用只读直通（探测新接口用）")
    s.add_argument("api", help="MTOP api 名，如 mtop.rm.sellercenter.ask.list")
    s.add_argument("--v", dest="version", default="1.0", help="版本号 (默认 1.0)")
    s.add_argument("--data", help="平铺的 data JSON")
    s.add_argument("--json-body", help="塞进 jsonBody 的 JSON")
    s.add_argument("--params", help="塞进 params 的 JSON")
    s.add_argument("--out", help="写到这个文件")
    s.set_defaults(func=cmd_api)

    return p


def _force_utf8() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    global _CLIENT
    _force_utf8()
    args = build_parser().parse_args(argv)
    _CLIENT = None
    try:
        args.func(args)
        return 0
    except SystemExit as e:
        return int(e.code or 0)
    except NotLoggedIn as e:
        print(f"✗ {e}", file=sys.stderr)
        return 2
    except TbError as e:
        print(f"✗ {e}", file=sys.stderr)
        return e.exit_code
    except (RuntimeError, ValueError) as e:
        print(f"✗ {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
