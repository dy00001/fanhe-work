"""把 data/raw/<module>/ 下抓到的生意参谋接口 JSON 展平成 CSV。

规则：
- 递归找出所有「记录列表」：元素为 dict 的数组，或元素为标量的数组
- 每个列表单独输出一张表，列 = 该列表内所有键的并集（嵌套对象用 a.b 展开）
- dict-of-list（以商品ID等为键）额外加一列 _key
- 同时生成字段清单，供后续建表定 schema 用
"""
import json
import os
import csv
import re
from collections import OrderedDict, defaultdict
from pathlib import Path

# 工作区根目录由脚本位置推导，盘符随电脑变化时无需修改。
ROOT = Path(__file__).resolve().parent.parent
RAW_ROOT = os.environ.get('RAW_ROOT', str(ROOT / 'data' / 'raw'))
CSV_ROOT = os.environ.get('CSV_ROOT', str(ROOT / 'data' / 'csv'))


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


def find_lists(node, path='data'):
    """产出 (路径, 列表) —— 元素为 dict 或标量"""
    found = []
    if isinstance(node, list):
        if node and all(isinstance(x, (dict,)) for x in node):
            found.append((path, node))
        elif node and all(not isinstance(x, (dict, list)) for x in node):
            found.append((path, node))
        else:
            for i, v in enumerate(node):
                found += find_lists(v, f'{path}[{i}]')
    elif isinstance(node, dict):
        for k, v in node.items():
            found += find_lists(v, f'{path}.{k}')
    return found


def pick_name(url):
    """从接口 URL 提取可读名"""
    if not url:
        return 'unknown'
    p = url.split('?')[0].replace('https://sycm.taobao.com', '')
    parts = [x for x in p.split('/') if x and x not in ('json',)]
    name = '_'.join(parts[-3:])
    name = re.sub(r'\.json$', '', name)
    name = re.sub(r'[^\w\-]', '_', name)
    return name


def write_csv(fp, rows):
    cols = []
    seen = set()
    flat_rows = []
    for r in rows:
        if isinstance(r, dict):
            fr = flatten(r)
        else:
            fr = OrderedDict([('value', r)])
        flat_rows.append(fr)
        for k in fr:
            if k not in seen:
                seen.add(k)
                cols.append(k)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for fr in flat_rows:
            w.writerow(fr)
    return len(rows), cols


def main():
    inventory = defaultdict(lambda: {'count': 0, 'tables': set(), 'samples': []})
    total_tables = 0
    log = []

    for module in sorted(os.listdir(RAW_ROOT)):
        mdir = os.path.join(RAW_ROOT, module)
        if not os.path.isdir(mdir):
            continue
        man = os.path.join(mdir, '_manifest.json')
        url_map = {}
        page_url = ''
        if os.path.exists(man):
            try:
                m = json.load(open(man, encoding='utf-8'))
                page_url = m.get('url') or m.get('page') or ''
                for s in m.get('saved', []):
                    url_map[s['file']] = s['url']
            except Exception:
                pass

        for fn in sorted(os.listdir(mdir)):
            if fn.startswith('_') or not fn.endswith('.json'):
                continue
            try:
                j = json.load(open(os.path.join(mdir, fn), encoding='utf-8'))
            except Exception:
                continue
            if not isinstance(j, dict) or j.get('code') not in (0, '0', None):
                continue
            url = url_map.get(fn, '')
            base = pick_name(url) or re.sub(r'\.json$', '', fn)[:50]
            base = re.sub(r'[^\w\-]', '_', base)
            lists = find_lists(j.get('data'), 'data')
            for path, lst in lists:
                if not lst:
                    continue
                if not isinstance(lst[0], dict):
                    lst = [{'value': x} for x in lst]
                tag = re.sub(r'[^\w\-\[\]]', '_', path.replace('data.', '').replace('[', '_').replace(']', ''))
                if len(lists) > 1 or True:
                    fp = os.path.join(CSV_ROOT, module, f'{base}__{tag}.csv')
                n, cols = write_csv(fp, lst)
                total_tables += 1
                for c in cols:
                    inventory[c]['count'] += 1
                    inventory[c]['tables'].add(f'{module}/{os.path.basename(fp)}')
                    if len(inventory[c]['samples']) < 3:
                        first = flatten(lst[0]).get(c)
                        inventory[c]['samples'].append(first)
                log.append((module, os.path.basename(fp), n, len(cols), url))

    print(f'共生成 {total_tables} 张表')
    for module, f, n, c, url in log:
        print(f'  [{module}] {f[:70]}  {n}行 x {c}列  <- {url.replace("https://sycm.taobao.com","")[:90]}')

    os.makedirs(CSV_ROOT, exist_ok=True)
    inv_fp = os.path.join(CSV_ROOT, 'FIELD-INVENTORY.csv')
    with open(inv_fp, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['字段', '出现表数', '示例值', '涉及表'])
        for k in sorted(inventory, key=lambda x: (-inventory[x]['count'], x)):
            v = inventory[k]
            w.writerow([k, v['count'], str(v['samples'][:2])[:80], '; '.join(sorted(v['tables'])[:4])])
    print(f'字段清单: {inv_fp}  ({len(inventory)} 个字段)')

    with open(os.path.join(CSV_ROOT, 'TABLE-INDEX.csv'), 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['模块', '文件', '行数', '列数', '来源接口'])
        for row in log:
            w.writerow(row)


if __name__ == '__main__':
    main()
