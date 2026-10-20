"""生意参谋接口 JSON -> CSV（正式版）

识别三种结构：
  A. data 为 {指标: {value, cycleCrc, ...}}  -> 长表：指标 / 数值 / 环比
  B. data 内含记录列表 [{...}, ...]          -> 宽表：字段即列
  C. data 为普通字典                          -> 单行宽表
"""
import json
import os
import re
import csv
from collections import OrderedDict
from pathlib import Path

# 工作区根目录由脚本位置推导，U 盘插到哪台电脑、盘符是 E 还是 F 都不影响。
ROOT = Path(__file__).resolve().parent.parent
RAW_ROOTS = os.environ.get('RAW_ROOTS', str(ROOT / 'data' / 'raw30')).split(',')
CSV_ROOT = os.environ.get('CSV_ROOT', str(ROOT / 'data' / 'csv30'))

# 接口 -> 中文表名（用于索引，未命中则用路径末段）
ENDPOINT_NAMES = {
    'tradinganaly/overview/get_summary': '交易概况-区间汇总',
    'tradinganaly/overview/getTendency': '交易概况-支付金额逐日',
    'tradinganaly/overview/getCateTop': '交易概况-类目排行',
    'tradinganaly/overview/getTradeExplanation': '交易概况-解读',
    'tradinganaly/overview/getConvertExplanation': '交易转化-解读',
    'flow/new/guide/trend/overview': '流量总览-核心指标',
    'flow/new/guide/trend': '流量-逐日趋势（访客/买家/商品访客）',
    'flow/shop/source/overview/v4': '流量-店铺来源总览',
    'flow/shop/source/tree/platform/support': '流量-来源平台明细',
    'flow/new/live/guide/trend': '流量-实时分时趋势',
    'flow/show/rank': '流量-来源排行',
    'visitor/distribution/listAreas': '流量-访客地域分布',
    'visitor/distribution/listFeatures': '流量-访客画像',
    'visitor/distribution/listBehaviors': '流量-访客行为',
    'visitor/distribution/listPeriods': '流量-分时段访客',
    'visitor/distribution/getAreaExplanation': '流量-地域解读',
    'visitor/distribution/getPeriodExplanation': '流量-时段解读',
    'wordAide/drainageSearch': '流量-引流搜索词',
    'new/monitor/item/tops/rank': '商品-流量排行',
    'new/item/getTops': '商品-新品榜',
    'refund/live/overview': '退款-实时总览',
    'refund/live/trend': '退款-趋势',
    'refund/close/overview': '退款-完结总览',
    'refund/reason/list': '退款-原因分布',
    'refund/item/view/top': '退款-商品TOP',
    'refund/strategy/live/list': '退款-策略提醒',
    'shop/refund/analysis': '退款-店铺分析',
}

# 框架类噪音接口，跳过
JUNK = re.compile(
    r'getCurrentTime|checkWhiteList|hidden/info|redeem/check|warn/live|live/chance'
    r'|new/events/list|compete/|getInitAccountDate|shop/getMainCateInfo|errorcode'
    r'|/permission|/menu/|aiclock|notify/check'
    r'|token/generate|rule/value|rule/button|/picturl/|angle/select|browseHistory'
    r'|supersku/verify|getDefCate|getStdCate|hasPriceAct|check-conf|realtime/switch'
    r'|realtime/setting|config/tag/shop|item/listAll|industry/mainCate|batch/commDate'
)

SKIP_DIRS = {'trade-detail-slow'}


def cn_name(url):
    path = url.split('?')[0].replace('https://sycm.taobao.com', '')
    for k, v in sorted(ENDPOINT_NAMES.items(), key=lambda x: -len(x[0])):
        if k in path:
            return v
    parts = [x for x in path.split('/') if x]
    return '/'.join(parts[-2:])


def tbl_name(url, idx=1):
    path = url.split('?')[0].replace('https://sycm.taobao.com', '').replace('.json', '')
    base = re.sub(r'[^\w]', '_', path.strip('/'))
    return f'{idx:02d}_{base}'


def normalize_row(fr):
    """把 a.b.value / a.b.cycleCrc 这类拆列压平成 a_b / a_b_环比"""
    out = OrderedDict()
    keys = set(fr.keys())
    for k, v in fr.items():
        if k.endswith('.cycleCrc'):
            continue
        if k.endswith('.value'):
            base = k[:-6]
            nm = base.replace('.', '_')
            out[nm] = v
            if base + '.cycleCrc' in keys:
                out[nm + '_环比'] = fr.get(base + '.cycleCrc')
        else:
            out[k.replace('.', '_')] = v
    return out


def flatten(d, prefix=''):
    out = OrderedDict()
    if isinstance(d, dict):
        for k, v in d.items():
            key = f'{prefix}.{k}' if prefix else str(k)
            if isinstance(v, (dict, list)):
                out.update(flatten(v, key))
            else:
                out[key] = v
    elif isinstance(d, list):
        out[prefix] = json.dumps(d, ensure_ascii=False)
    else:
        out[prefix] = d
    return out


def is_metric_map(d):
    if not isinstance(d, dict) or not d:
        return False
    vals = list(d.values())
    ok = [v for v in vals if isinstance(v, dict) and 'value' in v]
    return len(ok) >= max(2, int(len(vals) * 0.6))


def find_record_list(node, path='data'):
    """深度优先找第一个记录列表"""
    if isinstance(node, list):
        if node and all(isinstance(x, dict) for x in node):
            return path, node
        return None
    if isinstance(node, dict):
        for k, v in node.items():
            r = find_record_list(v, f'{path}.{k}')
            if r:
                return r
    return None


def write_rows(fp, cols, rows):
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    # lineterminator 固定为 \n：默认的 \r\n 会让同一份数据在换机重跑后
    # 整个文件都算改动（git 里表现为每行都变），排查真实差异时非常干扰。
    with open(fp, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore', lineterminator='\n')
        w.writeheader()
        for r in rows:
            w.writerow(r)


def convert_series(data, url, outdir, seq):
    """逐日序列：{'self':[{'device':'all','payAmt':[...]}], 'lastDay':'2026-10-18'}"""
    if not isinstance(data, dict) or 'lastDay' not in data:
        return None
    groups = [v for v in data.values() if isinstance(v, list) and v and isinstance(v[0], dict)]
    if not groups:
        return None
    rows = []
    for g in groups[0]:
        dims = {k: v for k, v in g.items() if not isinstance(v, list)}
        series = {k: v for k, v in g.items() if isinstance(v, list)}
        n = max((len(x) for x in series.values()), default=0)
        # 序列末端对齐 lastDay
        ends = [x for x in series.values() if x]
        total_len = max(len(x) for x in ends) if ends else n
        for i in range(total_len):
            offset_from_end = total_len - 1 - i
            row = OrderedDict(dims)
            row['date'] = shift_date(data['lastDay'], -offset_from_end)
            for k, arr in series.items():
                row[k] = arr[i] if i < len(arr) else None
            rows.append(row)
    if not rows:
        return None
    name = tbl_name(url, seq)
    cols = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    fp = os.path.join(outdir, f'{name}__逐日.csv')
    write_rows(fp, cols, rows)
    return [(fp, cn_name(url) + '（逐日）', len(rows), len(cols), url)]


def shift_date(day, delta):
    import datetime
    d = datetime.date.fromisoformat(str(day)[:10])
    return (d + datetime.timedelta(days=delta)).isoformat()


def parse_range_year(url):
    """从 dateRange=YYYY-MM-DD|YYYY-MM-DD 取起始年份，用于给 MM-DD 补年份"""
    m = re.search(r'dateRange=(\d{4})-\d{2}-\d{2}', url or '')
    return m.group(1) if m else None


def build_dates(stats, year):
    """statDate 是 MM-DD 不带年份。跨年时月份回退即视为下一年。"""
    out, prev = [], None
    y = int(year)
    for s in stats:
        mm = int(str(s).split('-')[0])
        if prev is not None and mm < prev:
            y += 1
        out.append(f'{y}-{s}')
        prev = mm
    return out


def convert_statdate(data, url, outdir, seq):
    """逐日多指标：{'my': {'statDate': ['09-19', ...], 'uv': [...], 'payByrCnt': [...]}, ...}

    这是 /flow/new/guide/trend 的结构。此前被 flatten 成单行 CSV，30 天的
    访客 / 支付买家 / 商品访客逐日序列全部退化成 JSON 字符串，导致前端只能
    按 30 天日均估算。这里按 statDate 展开成一天一行。
    rivalAvg / rivalGood / myPre 等无 statDate 的分组长度相同，按索引对齐一并输出。
    """
    if not isinstance(data, dict):
        return None
    anchors = [(k, v) for k, v in data.items()
               if isinstance(v, dict) and isinstance(v.get('statDate'), list)]
    if not anchors:
        return None
    year = parse_range_year(url)
    if not year:
        return None
    dates = build_dates(anchors[0][1]['statDate'], year)
    n = len(dates)
    if not n:
        return None

    cols = ['date']
    per_day = [{'date': d} for d in dates]
    for gname, g in data.items():
        if not isinstance(g, dict):
            continue
        for metric, arr in g.items():
            if metric == 'statDate':
                continue
            if not isinstance(arr, list) or len(arr) != n:
                continue
            if not all(isinstance(x, (int, float)) for x in arr):
                continue
            key = f'{gname}_{metric}'
            cols.append(key)
            for i in range(n):
                per_day[i][key] = arr[i]
    if len(cols) <= 1:
        return None

    name = tbl_name(url, seq)
    fp = os.path.join(outdir, f'{name}__逐日多指标.csv')
    write_rows(fp, cols, per_day)
    return [(fp, cn_name(url) + '（逐日多指标）', n, len(cols), url)]


def convert(j, url, outdir, seq):
    data = j.get('data')
    if data is None:
        return None
    special = convert_series(data, url, outdir, seq)
    if special:
        return special
    multi = convert_statdate(data, url, outdir, seq)
    if multi:
        return multi
    name = tbl_name(url, seq)
    label = cn_name(url)

    files = []
    if is_metric_map(data):
        rows = []
        for metric, mv in data.items():
            if isinstance(mv, dict):
                row = OrderedDict([('metric', metric)])
                row.update({k: v for k, v in mv.items() if not isinstance(v, (dict, list))})
                rows.append(row)
            else:
                rows.append(OrderedDict([('metric', metric), ('value', mv)]))
        cols = []
        for r in rows:
            for k in r:
                if k not in cols:
                    cols.append(k)
        fp = os.path.join(outdir, f'{name}__指标长表.csv')
        write_rows(fp, cols, rows)
        files.append((fp, label + '（指标长表）', len(rows), len(cols), url))

    # 同时把其中的记录列表也导出
    cnt = 0
    def scan(node, path):
        nonlocal cnt
        if isinstance(node, list):
            if node and all(isinstance(x, dict) for x in node):
                cnt += 1
                rows = [normalize_row(flatten(x)) for x in node]
                cols = []
                for r in rows:
                    for k in r:
                        if k not in cols:
                            cols.append(k)
                tag = re.sub(r'[^\w]', '_', path.replace('data.', '').replace('.', '_'))
                fp = os.path.join(outdir, f'{name}__{tag}.csv')
                write_rows(fp, cols, rows)
                files.append((fp, f'{label} / {path}', len(rows), len(cols), url))
            return
        if isinstance(node, dict):
            for k, v in node.items():
                scan(v, f'{path}.{k}')
    scan(data, 'data')

    if not files:
        fr = flatten(data)
        fp = os.path.join(outdir, f'{name}__单行.csv')
        write_rows(fp, list(fr.keys()), [fr])
        files.append((fp, label, 1, len(fr), url))
    return files


def main():
    index = []
    seen_url = set()
    for root in RAW_ROOTS:
        if not os.path.isdir(root):
            continue
        for module in sorted(os.listdir(root)):
            mdir = os.path.join(root, module)
            if not os.path.isdir(mdir):
                continue
            if module in SKIP_DIRS:
                continue
            man = os.path.join(mdir, '_manifest.json')
            url_map = {}
            if os.path.exists(man):
                try:
                    m = json.load(open(man, encoding='utf-8'))
                    for s in m.get('saved', []):
                        url_map[os.path.basename(s['file'])] = s['url']
                except Exception:
                    pass
            outdir = os.path.join(CSV_ROOT, module)
            # csv30 是派生目录，每次全量重算。先清掉旧 CSV，否则改了输出命名
            # （例如 __单行 变 __逐日多指标）会留下过期表，报表里出现两份同名数据。
            os.makedirs(outdir, exist_ok=True)
            for old in os.listdir(outdir):
                if old.endswith('.csv'):
                    os.remove(os.path.join(outdir, old))
            seq = 0
            for fn in sorted(os.listdir(mdir)):
                if fn.startswith('_') or not fn.endswith('.json'):
                    continue
                url = url_map.get(fn, '')
                if not url or 'alicdn' in url:
                    continue
                if not re.search(r'/(bda|cc|flow|qos|fa|xsite|csp|ipoll|api)/', url):
                    continue
                if JUNK.search(url):
                    continue
                key = url.split('&_=')[0]
                if key in seen_url:
                    continue
                try:
                    j = json.load(open(os.path.join(mdir, fn), encoding='utf-8'))
                except Exception:
                    continue
                if not isinstance(j, dict) or j.get('code') not in (0, '0', 200, '200'):
                    continue
                seen_url.add(key)
                seq += 1
                res = convert(j, url, outdir, seq)
                if res:
                    index += res

    os.makedirs(CSV_ROOT, exist_ok=True)
    with open(os.path.join(CSV_ROOT, 'INDEX.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['模块', '文件', '中文名', '行数', '列数', '来源接口'])
        for fp, label, n, c, url in index:
            rel = os.path.relpath(fp, CSV_ROOT).replace('\\', '/')
            w.writerow([rel.split('/')[0], rel.split('/')[-1], label, n, c, url.replace('https://sycm.taobao.com', '')])
    print(f'生成 {len(index)} 张表 -> {CSV_ROOT}')


if __name__ == '__main__':
    main()
