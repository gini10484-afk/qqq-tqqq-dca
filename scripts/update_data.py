#!/usr/bin/env python3
"""拉 QQQ、TQQQ、SPY 的历史行情，检查一遍，写进 docs/data.json。

TQQQ 2010-02-11 才成立，之前的部分用「QQQ 日涨跌 ×3 − 杠杆成本」模拟。
模拟公式里的系数是用 2010 年之后的真实数据拟合出来的（见 README），
16 年半的复利误差约 4.5%。模拟出来的那段在 data.json 里标成 real=0，网页会提示。

SPY（标普500）是 1993 年就有的真实数据，稳妥模式拿它当核心打底，不需要模拟。

data.json 的每一行是：
[日期, QQQ 收盘价, QQQ 复权价, TQQQ 复权价, TQQQ 是否真实(1/0), SPY 复权价]
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "docs", "data.json")

UA = {"User-Agent": "Mozilla/5.0 (compatible; qqq-tqqq-dca/1.0; +https://github.com/)"}
CHART = "https://query{n}.finance.yahoo.com/v8/finance/chart/{sym}?period1=0&period2=9999999999&interval=1d&events=div%2Csplit"

# 美国联邦基金利率年平均值（%）。模拟 TQQQ 的杠杆成本要用。以后补新年份不影响已有数据。
FED_FUNDS = {
    1999: 4.97, 2000: 6.24, 2001: 3.89, 2002: 1.67, 2003: 1.13, 2004: 1.35,
    2005: 3.22, 2006: 4.97, 2007: 5.02, 2008: 1.92, 2009: 0.16, 2010: 0.18,
}
# 漂移（%/年） = DRIFT_A + DRIFT_B * 联邦基金利率；用 2010-2026 的真实 TQQQ 拟合
DRIFT_A = -1.814
DRIFT_B = -2.258
TRADING_DAYS = 252


def fetch_yfinance(symbol):
    """备用接口：Yahoo 的直连被挡时用 yfinance（它会自己处理 cookie）。"""
    import yfinance  # 只有走到这一步才需要这个包

    df = yfinance.Ticker(symbol).history(period="max", auto_adjust=False)
    if df is None or df.empty:
        raise RuntimeError("yfinance 没拿到 %s 的数据" % symbol)
    out = []
    for idx, row in df.iterrows():
        c, a = row.get("Close"), row.get("Adj Close", row.get("Close"))
        if c is None or a is None or not (c > 0) or not (a > 0):
            continue
        out.append((idx.strftime("%Y-%m-%d"), float(c), float(a)))
    return out


def fetch(symbol):
    """从 Yahoo 拉一只票的完整历史；query1 不行就换 query2，都不行再用 yfinance。"""
    last = None
    for n in (1, 2):
        url = CHART.format(n=n, sym=symbol)
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.load(r)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            time.sleep(2)
            continue
        res = (data.get("chart") or {}).get("result") or []
        if not res:
            last = RuntimeError("Yahoo 没返回数据：%s" % str(data)[:200])
            continue
        res = res[0]
        ts = res.get("timestamp") or []
        quote = (res.get("indicators") or {}).get("quote") or [{}]
        adjs = (res.get("indicators") or {}).get("adjclose") or [{}]
        close = quote[0].get("close") or []
        adj = adjs[0].get("adjclose") or close
        out = []
        for i, t in enumerate(ts):
            c = close[i] if i < len(close) else None
            a = adj[i] if i < len(adj) else None
            if c is None or a is None or not (c > 0) or not (a > 0):
                continue
            day = time.strftime("%Y-%m-%d", time.gmtime(t))
            out.append((day, float(c), float(a)))
        if len(out) > 100:
            return out
        last = RuntimeError("%s 只拿到 %d 行" % (symbol, len(out)))
    try:
        rows = fetch_yfinance(symbol)
        if len(rows) > 100:
            print("直连失败（%s），改用 yfinance 拿到 %s 的 %d 行" % (last, symbol, len(rows)))
            return rows
    except Exception as e:  # noqa: BLE001
        last = e
    raise RuntimeError("拉 %s 失败：%s" % (symbol, last))


def sanity(rows, name):
    """基本检查：日期递增、没有重复、单日涨跌不离谱。"""
    if len(rows) < 100:
        raise RuntimeError("%s 行数太少：%d" % (name, len(rows)))
    for i in range(1, len(rows)):
        if rows[i][0] <= rows[i - 1][0]:
            raise RuntimeError("%s 日期没有递增：%s 之后是 %s" % (name, rows[i - 1][0], rows[i][0]))
        prev, cur = rows[i - 1][2], rows[i][2]
        if prev > 0:
            chg = abs(cur / prev - 1)
            limit = 0.75 if name == "TQQQ" else 0.25  # TQQQ 是 3 倍，单日波动更大
            if chg > limit:
                raise RuntimeError("%s %s 单日变动 %.1f%%，看起来不对" % (name, rows[i][0], chg * 100))
    return True


def simulate_tqqq(qqq_rows, real_by_date, first_real_date):
    """1999—2010 没有 TQQQ，用 3×QQQ 日涨跌减去杠杆成本模拟出来。"""
    out = []
    level = 1.0
    prev_adj = None
    last_ff = FED_FUNDS[max(FED_FUNDS)]
    for day, close, adj in qqq_rows:
        if day >= first_real_date:
            break
        if prev_adj is None:
            out.append((day, level, 0))
            prev_adj = adj
            continue
        year = int(day[:4])
        ff = FED_FUNDS.get(year, last_ff)
        drift = (DRIFT_A + DRIFT_B * ff) / 100.0
        level *= 1 + 3 * (adj / prev_adj - 1) + drift / TRADING_DAYS
        prev_adj = adj
        out.append((day, level, 0))
    # 让模拟段和真实段接得上：整段等比缩放，使模拟段最后一天等于真实 TQQQ 的第一个价格
    if out and first_real_date in real_by_date and out[-1][1] > 0:
        scale = real_by_date[first_real_date] / out[-1][1]
        out = [(d, v * scale, 0) for d, v, _ in out]
    return out


def build():
    qqq = fetch("QQQ")
    tqqq = fetch("TQQQ")
    spy = fetch("SPY")
    sanity(qqq, "QQQ")
    sanity(tqqq, "TQQQ")
    sanity(spy, "SPY")

    t_by_date = {d: a for d, _c, a in tqqq}
    s_by_date = {d: a for d, _c, a in spy}
    first_real = tqqq[0][0]

    sim = simulate_tqqq(qqq, t_by_date, first_real)
    sim_by_date = {d: v for d, v, _ in sim}

    rows = []
    missing_spy = 0
    for day, close, adj in qqq:
        if day in t_by_date:
            t, real = t_by_date[day], 1
        elif day in sim_by_date:
            t, real = sim_by_date[day], 0
        else:
            continue  # QQQ 有而 TQQQ 两边都没有的日子（极少）直接跳过，保证几条线对齐
        sp = s_by_date.get(day)
        if sp is None:
            missing_spy += 1
            continue
        rows.append([day, round(close, 4), round(adj, 6), round(t, 6), real, round(sp, 6)])

    if len(rows) < 1000:
        raise RuntimeError("合并后只剩 %d 行，放弃这次更新" % len(rows))
    if missing_spy > 5:
        raise RuntimeError("有 %d 个交易日拿不到 SPY，放弃这次更新" % missing_spy)

    payload = {
        "symbol": "QQQ+TQQQ+SPY",
        "source": "Yahoo Finance",
        "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "firstRealTqqq": first_real,
        "fedFunds": FED_FUNDS,
        "drift": {"a": DRIFT_A, "b": DRIFT_B},
        "cols": ["date", "qqqClose", "qqqAdj", "tqqqAdj", "tqqqReal", "spyAdj"],
        "rows": rows,
    }

    # 和旧数据比一比，行数骤减就不覆盖
    if os.path.exists(OUT):
        try:
            with open(OUT, encoding="utf-8") as f:
                old = json.load(f)
            if len(old.get("rows", [])) > len(rows) + 5:
                raise RuntimeError("新数据 %d 行比旧数据 %d 行少太多" % (len(rows), len(old["rows"])))
        except (ValueError, OSError):
            pass

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"), ensure_ascii=False)
    print("写好了 %s：%d 行，%s → %s，真实 TQQQ 从 %s 开始"
          % (OUT, len(rows), rows[0][0], rows[-1][0], first_real))
    return payload


if __name__ == "__main__":
    try:
        build()
    except Exception as e:  # noqa: BLE001 —— 失败就退出，工作流会保留旧数据
        print("更新失败：%s" % e, file=sys.stderr)
        sys.exit(1)
