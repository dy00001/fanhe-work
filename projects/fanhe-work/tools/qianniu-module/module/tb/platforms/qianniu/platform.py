"""千牛（myseller.taobao.com）平台描述。全部只读，且全部经 MTOP 网关。

为什么不直接打卖家中心的页面接口：千牛卖家中心的数据都走 MTOP
（`https://h5api.m.taobao.com/h5/<api>/<version>/`），签名算法在 `core/mtop.py`。
取数桥插件给千牛放行的也正是这个网关 —— `extension/unpacked/background.js` 里
`https://myseller.taobao.com/robots.txt` 那一项的 ALLOWED 只有 h5api 和一条 ASCP 代理，
**页面 HTML 本身不放行**。所以这一层只需要会签 MTOP，不需要页面路径。

`launch_url` 用 myseller 的 robots.txt：插件在哪个页面下「用页面自己的身份」发请求，
就得先打开那个域；robots.txt 是最轻的同域文档（和 sycm/dmp 的做法一致）。
"""
import re

from ...core.platform import Platform
from . import session

# 读取通道一律拒绝的「动词」—— 和插件 background.js 里千牛那一项的 WRITE 逐字一致。
# 两边必须同步：命令行放过而插件拦下时，用户只会看到插件报「被拒绝」，很难看出是这里少写了。
WRITE_RE = re.compile(
    r"(update|create|delete|modify|save|add|remove|edit|submit|send|post|set"
    r"|operate|publish|cancel|confirm|pay|refund)",
    re.I,
)

# 名字被 WRITE_RE 误拦、但核实过是只读的接口（精确路径，带版本段）。
# 和插件 background.js 里千牛那一项的 READS 必须一样 —— 三行 base 的退款统计/指标/列表
# 名字里带 refund，是退款管理页自己用的读接口。
READ_ALLOW = (
    "/mtop.alibaba.refundface2.disputeservice.qianniu.pc.statistic/1.0/",
    "/mtop.alibaba.refundface2.disputeservice.qianniu.pc.indecator/1.0/",
    "/mtop.alibaba.refundface2.disputeservice.qianniu.pc.disputelistv2/1.0/",
)

QIANNIU = Platform(
    name="qianniu",
    display="千牛",
    # 只有一个 host：MTOP 网关。签名用的 appKey 与令牌都在 core/mtop.py。
    hosts={"gw": "https://h5api.m.taobao.com/h5"},
    login_page="https://myseller.taobao.com/home.htm",
    launch_url="https://myseller.taobao.com/robots.txt",
    login_cookies=("cookie2", "unb"),
    cookie_domains=("taobao.com", "myseller.taobao.com"),
    referer="https://myseller.taobao.com/home.htm",
    expired_hints=(),
    write_re=WRITE_RE,
    read_allow=READ_ALLOW,
    env_prefix="QIANNIU",
    risk_words=("滑块", "验证码", "操作过于频繁", "请重新登录", "异常请求", "风控"),
    # 比生意参谋稳一些：同一个网关下的不同 api 之间没有会话状态要抢；但间隔还是给足，
    # 问大家要连翻 5–6 页，别让平台看出是脚本。
    delay=(1.2, 2.2),
    warn_after=200,
    readable_cookies=("_m_h5_tk", "_m_h5_tk_enc", "_tb_token_"),
    build_request=session.build_request,
    check_payload=session.check_payload,
    min_extension="0.8.0",
)
