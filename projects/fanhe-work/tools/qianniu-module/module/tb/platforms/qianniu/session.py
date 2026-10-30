"""千牛（MTOP 网关）的会话钩子：签名、业务检查、店铺识别。

签名和令牌换发全在 `core/mtop.py`（千牛、达摩盘、竞品评价都走同一个网关），这里只做转接。
"""
from __future__ import annotations

from ...core import mtop

# 平台钩子统一是四参数 (client, host, path, params)，mtop.signed_request 是三参数（只有一个网关，
# 不需要 host）。这两行就是全部差异 —— 复用它而不是抄一份签名逻辑。
check_payload = mtop.check_mtop


def build_request(client, host: str, path: str, params: dict):
    return mtop.signed_request(client, path, params)


def shop_of(payload, url: str = "") -> str | None:
    """千牛的回包里没有能对到「店铺编号」的字段。

    卖家 id 出现在问大家的检索串里（`seller_id:"2486239571"`），但那是**卖家账号**的 id，
    不是生意参谋那套店铺编号（`--shop` 比的是后者）。拿它当店铺号去比，只会让每一次请求都被
    判成「串店」（ShopChanged），比不认店更糟。所以在千牛上不认店 —— 一个登录对应一家店时
    本来也没有串店的空间；真要看多店，用 `tb account` 换账号。
    """
    return None
