/*!
 * QQQ + TQQQ 组合定投的规则和回测
 * 同一份代码给网页和测试用（浏览器里是 window.DCA2，Node 里是 module.exports）
 *
 * 一句话规则：平时定投 QQQ；QQQ 跌破 200 日均线、而且离近一年最高点跌够多时，
 * 这一次的钱改买 TQQQ（3 倍做多纳指）；TQQQ 平时不卖，但占比超过上限就把超出的部分换回 QQQ。
 *
 * 重要：TQQQ 是每日 3 倍杠杆，长期单独持有会被磨损。1999 年一次性买入模拟的 TQQQ 拿到 2026 年
 * 只有 1.9 倍，同期 QQQ 是 16.5 倍，因为 2000—2002 年它跌掉了 99.95%。所以这里只把它当
 * “大跌时的加码工具”，而且一定要有占比上限。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DCA2 = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY_MS = 86400000;

  // 网页第一次打开时的默认设置；改这里也会改定投日提醒
  var DEFAULT_CONFIG = {
    baseAmount: 100, // 每次的基础金额（美元）
    investWeekday: 1, // 每周几定投，1 = 周一
    frequency: "weekly", // "weekly" 每周一次 | "daily" 每个交易日
    basis: "52w", // 回撤跟谁比："52w" 近一年最高点 | "ath" 历史最高点
    maWindow: 200, // 均线天数
    dipThreshold: 20, // 跌破均线 + 回撤到这个百分比，才把钱买 TQQQ
    tqqqCap: 20, // TQQQ 占组合的上限（%），超过就换回 QQQ
    flowShare: 100, // 触发时，这一次的钱有百分之几买 TQQQ
    sellOnRecover: false, // 老设置，等同于 sellMode:"ma"（留着兼容以前存的设置）
    sellMode: "cap", // 卖出规则：
    //   "cap"  只守占比上限，不择时卖（回测里唯一站得住的）
    //   "ma"   涨回 200 日均线就把 TQQQ 全换成 QQQ
    //   "peak" 涨回近一年最高点附近就把 TQQQ 减到目标比例
    //   "none" 完全不卖，连上限也不管（很危险，只用来做对照）
    sellPeakWithin: 5, // "peak"：离近一年最高点不到这么多个百分点就减仓
    sellTargetShare: 10, // "peak"：减到组合的百分之几
    hotAbove: 15, // 比均线高这么多算“涨太多”
    hotMultiplier: 0.5, // 涨太多时的倍数
    tiers: [
      { drawdown: 0, multiplier: 1.5 },
      { drawdown: 20, multiplier: 2 },
      { drawdown: 30, multiplier: 3 },
    ], // 跌破均线后按回撤分档加码
  };

  // 稳妥模式：不择时、三层配比、定期再平衡。和上面那套规则完全独立
  var STEADY_DEFAULT = {
    coreWeight: 60, // SPY 标普500（核心打底）
    qqqWeight: 30, // QQQ 纳指100（成长卫星）
    tqqqWeight: 10, // TQQQ（杠杆，亏光也不影响生活的那部分）
    rebalance: "yearly", // "yearly" 每年一次 | "band" 偏离超过 band 才动 | "never" 只用新钱补
    band: 5, // band 模式：某一层偏离目标几个百分点才动手
  };

  var WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var MODE_NAMES = {
    plainQ: "普通定投（只买 QQQ）",
    comboQ: "综合策略（只买 QQQ）",
    fixed: "每次固定比例买 TQQQ",
    dip: "大跌才买 TQQQ",
    steady: "稳妥模式（宽基打底）",
  };
  var REBALANCE_NAMES = { yearly: "每年一次", band: "偏离超过阈值才动", never: "只用新钱补，不卖" };
  var STATE_LABELS = { hot: "涨太多", up: "正常上涨", dip: "上涨中回调", down: "下跌趋势" };

  // ---------- 日期工具（只算日期，不涉及时区） ----------
  function dayNumber(dateStr) {
    var p = String(dateStr).split("-");
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY_MS);
  }
  function dateFromDayNumber(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }
  function weekdayOf(dayNum) {
    return ((dayNum + 4) % 7 + 7) % 7; // 1970-01-01 是周四
  }
  function mondayOf(dayNum) {
    var w = weekdayOf(dayNum);
    return dayNum - ((w + 6) % 7);
  }

  // ---------- 设置 ----------
  function normalizeTiers(tiers, fallback) {
    var list = (tiers || [])
      .map(function (t) {
        return { drawdown: Number(t.drawdown), multiplier: Number(t.multiplier) };
      })
      .filter(function (t) {
        return isFinite(t.drawdown) && t.drawdown >= 0 && t.drawdown < 100 && isFinite(t.multiplier) && t.multiplier >= 0 && t.multiplier <= 20;
      })
      .sort(function (a, b) { return a.drawdown - b.drawdown; });
    if (!list.length) return fallback.map(function (t) { return { drawdown: t.drawdown, multiplier: t.multiplier }; });
    if (list[0].drawdown > 0) list.unshift({ drawdown: 0, multiplier: list[0].multiplier });
    return list;
  }
  function num(v, lo, hi, dflt) {
    var x = Number(v);
    return isFinite(x) && x >= lo && x <= hi ? x : dflt;
  }
  var SELL_MODES = ["cap", "ma", "peak", "none"];
  var SELL_NAMES = {
    cap: "只守占比上限（不择时卖）",
    ma: "涨回 200 日均线就全换回 QQQ",
    peak: "涨回前高附近就减到目标比例",
    none: "完全不卖（连上限也不管）",
  };
  // 以前只有 sellOnRecover 这个开关，读到老设置时把它翻译成 sellMode
  function normalizeSellMode(c) {
    if (c && SELL_MODES.indexOf(c.sellMode) >= 0) return c.sellMode;
    if (c && c.sellOnRecover) return "ma";
    return DEFAULT_CONFIG.sellMode;
  }

  function withDefaults(config) {
    var c = config || {};
    var d = DEFAULT_CONFIG;
    return {
      baseAmount: num(c.baseAmount, 0.01, 1e7, d.baseAmount),
      investWeekday: num(c.investWeekday, 1, 5, d.investWeekday),
      frequency: c.frequency === "daily" ? "daily" : "weekly",
      basis: c.basis === "ath" ? "ath" : "52w",
      maWindow: Math.round(num(c.maWindow, 20, 400, d.maWindow)),
      dipThreshold: num(c.dipThreshold, 0, 60, d.dipThreshold),
      tqqqCap: num(c.tqqqCap, 0, 100, d.tqqqCap),
      flowShare: num(c.flowShare, 0, 100, d.flowShare),
      sellOnRecover: !!c.sellOnRecover,
      sellMode: normalizeSellMode(c),
      sellPeakWithin: num(c.sellPeakWithin, 0, 30, d.sellPeakWithin),
      sellTargetShare: num(c.sellTargetShare, 0, 100, d.sellTargetShare),
      hotAbove: num(c.hotAbove, 0, 100, d.hotAbove),
      hotMultiplier: num(c.hotMultiplier, 0, 5, d.hotMultiplier),
      tiers: normalizeTiers(c.tiers, d.tiers),
    };
  }

  // 稳妥模式的设置：三个权重加起来归一到 100
  function steadyDefaults(s) {
    var c = s || {}, d = STEADY_DEFAULT;
    var a = num(c.coreWeight, 0, 100, d.coreWeight);
    var b = num(c.qqqWeight, 0, 100, d.qqqWeight);
    var t = num(c.tqqqWeight, 0, 100, d.tqqqWeight);
    var sum = a + b + t;
    if (!(sum > 0)) { a = d.coreWeight; b = d.qqqWeight; t = d.tqqqWeight; sum = 100; }
    var mode = c.rebalance === "band" || c.rebalance === "never" ? c.rebalance : "yearly";
    return {
      coreWeight: a / sum * 100,
      qqqWeight: b / sum * 100,
      tqqqWeight: t / sum * 100,
      rebalance: mode,
      band: num(c.band, 0.5, 30, d.band),
    };
  }

  // ---------- 数据 ----------
  // rows: [日期, QQQ 收盘, QQQ 复权价, TQQQ 复权价, 是不是真实 TQQQ 数据(1/0), SPY 复权价]
  // 第 6 列（SPY）是后来加的，旧的 data.json 没有也不会报错，只是稳妥模式用不了
  function prepare(data) {
    var rows = (data && data.rows) || [];
    var n = rows.length;
    var s = {
      n: n, dates: new Array(n), day: new Array(n),
      close: new Float64Array(n), adj: new Float64Array(n),
      t: new Float64Array(n), real: new Uint8Array(n),
      spy: new Float64Array(n),
    };
    var spyOk = n > 0;
    for (var i = 0; i < n; i++) {
      var r = rows[i];
      s.dates[i] = r[0];
      s.day[i] = dayNumber(r[0]);
      s.close[i] = +r[1];
      s.adj[i] = +r[2];
      s.t[i] = +r[3];
      s.real[i] = r[4] ? 1 : 0;
      var sp = r.length > 5 ? +r[5] : NaN;
      if (isFinite(sp) && sp > 0) s.spy[i] = sp; else spyOk = false;
    }
    s.hasSpy = spyOk;
    s.firstRealIdx = -1;
    for (var k = 0; k < n; k++) if (s.real[k]) { s.firstRealIdx = k; break; }
    return s;
  }

  // 离最高点跌了多少（%）
  function drawdowns(series, basis) {
    var n = series.n, p = series.adj;
    var dd = new Float64Array(n), peak = new Float64Array(n);
    if (basis === "ath") {
      var hi = -Infinity;
      for (var i = 0; i < n; i++) {
        if (p[i] > hi) hi = p[i];
        peak[i] = hi;
        dd[i] = (1 - p[i] / hi) * 100;
      }
      return { dd: dd, peak: peak };
    }
    var win = 252, q = new Int32Array(n), head = 0, tail = 0;
    for (var j = 0; j < n; j++) {
      while (tail > head && q[head] < j - win + 1) head++;
      while (tail > head && p[q[tail - 1]] <= p[j]) tail--;
      q[tail++] = j;
      var h = p[q[head]];
      peak[j] = h;
      dd[j] = (1 - p[j] / h) * 100;
    }
    return { dd: dd, peak: peak };
  }

  // 均线，和“比均线高/低百分之几”
  function trendLines(series, win) {
    var n = series.n, p = series.adj;
    var ma = new Float64Array(n), dev = new Float64Array(n), ok = new Uint8Array(n);
    var sum = 0;
    for (var i = 0; i < n; i++) {
      sum += p[i];
      if (i >= win) sum -= p[i - win];
      if (i >= win - 1) {
        ma[i] = sum / win;
        dev[i] = (p[i] / ma[i] - 1) * 100;
        ok[i] = 1;
      }
    }
    return { ma: ma, dev: dev, ok: ok };
  }

  function multiplierFor(ddPct, tiers) {
    var m = tiers[0] ? tiers[0].multiplier : 1;
    for (var i = 0; i < tiers.length; i++) if (ddPct >= tiers[i].drawdown) m = tiers[i].multiplier;
    return m;
  }

  // 某一天（用这一天的收盘价）该怎么投
  function decide(cfg, dd, dev, ok, i) {
    if (i < 0 || !ok[i]) return { state: "up", multiplier: 1, buyTqqq: false };
    if (dev[i] < 0) {
      return {
        state: "down",
        multiplier: multiplierFor(dd[i], cfg.tiers),
        buyTqqq: dd[i] >= cfg.dipThreshold,
      };
    }
    if (dev[i] >= cfg.hotAbove) return { state: "hot", multiplier: cfg.hotMultiplier, buyTqqq: false };
    if (dd[i] >= 10) return { state: "dip", multiplier: 1, buyTqqq: false };
    return { state: "up", multiplier: 1, buyTqqq: false };
  }

  // 哪些天要投：每周定投取当周第一个不早于定投日的交易日；每日定投就是每个交易日
  function investDays(series, weekday, frequency) {
    var out = [], n = series.n, day = series.day, i = 0;
    if (frequency === "daily") {
      for (i = 0; i < n; i++) out.push(i);
      return out;
    }
    while (i < n) {
      var monday = mondayOf(day[i]);
      var j = i, pick = -1;
      while (j < n && mondayOf(day[j]) === monday) {
        if (pick < 0 && weekdayOf(day[j]) >= weekday) pick = j;
        j++;
      }
      if (pick < 0) {
        // 这周定投日当天及之后都休市：用这周最后一个交易日；数据里的最后一周先不算
        if (j < n) pick = j - 1;
        else break;
      }
      out.push(pick);
      i = j;
    }
    return out;
  }

  // 最新数据之后的下一个定投日（不知道美股假期，遇休市顺延）
  function nextInvestDate(lastDateStr, weekday, frequency) {
    var d = dayNumber(lastDateStr) + 1;
    if (frequency === "daily") {
      while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d++;
      return dateFromDayNumber(d);
    }
    while (weekdayOf(d) !== weekday) d++;
    return dateFromDayNumber(d);
  }

  // ---------- 当前信号 ----------
  function currentSignal(series, config, pre) {
    var cfg = withDefaults(config);
    var n = series.n;
    if (!n) return null;
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var i = n - 1; // 用最后一个交易日的收盘价决定下一次怎么投
    var r = decide(cfg, dd, tl.dev, tl.ok, i);
    return {
      basedOn: series.dates[i],
      nextDate: nextInvestDate(series.dates[i], cfg.investWeekday, cfg.frequency),
      weekdayName: WEEKDAY_CN[(weekdayOf(dayNumber(nextInvestDate(series.dates[i], cfg.investWeekday, cfg.frequency))) + 7) % 7],
      state: r.state,
      stateLabel: STATE_LABELS[r.state],
      multiplier: r.multiplier,
      amount: cfg.baseAmount * r.multiplier,
      asset: r.buyTqqq ? "TQQQ" : "QQQ",
      tqqqAmount: r.buyTqqq ? cfg.baseAmount * r.multiplier * cfg.flowShare / 100 : 0,
      drawdown: dd[i],
      dev: tl.ok[i] ? tl.dev[i] : null,
      ma: tl.ok[i] ? tl.ma[i] : null,
      price: series.adj[i],
      close: series.close[i],
      tqqqPrice: series.t[i],
      frequency: cfg.frequency,
      sellOnRecover: cfg.sellOnRecover && tl.ok[i] && tl.dev[i] >= 0,
    };
  }

  // ---------- 现在到底该买还是该卖 ----------
  // 一次算清楚：这次买什么、要不要减 TQQQ、离各个门槛还差多少。
  // holding 可以不传；传了才会算具体卖几股。
  function currentStatus(series, config, holding, pre) {
    var cfg = withDefaults(config);
    var n = series.n;
    if (!n) return null;
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var i = n - 1; // 用最后一个交易日的收盘价判断
    var r = decide(cfg, dd, tl.dev, tl.ok, i);
    var next = nextInvestDate(series.dates[i], cfg.investWeekday, cfg.frequency);
    var hasMA = !!tl.ok[i];
    var belowMA = hasMA && tl.dev[i] < 0;
    var deepEnough = dd[i] >= cfg.dipThreshold;

    // 卖出规则怎么说
    var target = sellTargetFor(cfg, dd, tl, i);
    var sellNote = "";
    if (cfg.sellMode === "cap") sellNote = "只在 TQQQ 超过 " + cfg.tqqqCap + "% 上限时换回 QQQ，不按行情择时卖。";
    else if (cfg.sellMode === "none") sellNote = "你选了完全不卖，连上限也不管。";
    else if (cfg.sellMode === "ma") {
      sellNote = target !== null
        ? "已经站回 " + cfg.maWindow + " 日均线上方，按规则把 TQQQ 全部换成 QQQ。"
        : "还在 " + cfg.maWindow + " 日均线下方，先不卖。";
    } else if (cfg.sellMode === "peak") {
      sellNote = target !== null
        ? "离近一年最高点只差 " + dd[i].toFixed(1) + "%（门槛 " + cfg.sellPeakWithin + "%），按规则把 TQQQ 减到 " + cfg.sellTargetShare + "%。"
        : "离近一年最高点还有 " + dd[i].toFixed(1) + "%，没到 " + cfg.sellPeakWithin + "% 的减仓门槛。";
    }

    // 持仓（可选）
    var hold = null;
    if (holding) {
      var q = Math.max(0, Number(holding.qqqShares) || 0);
      var t = Math.max(0, Number(holding.tqqqShares) || 0);
      var pq = series.adj[i], pt = series.t[i];
      var vq = q * pq, vt = t * pt, tot = vq + vt;
      var share = tot > 0 ? vt / tot * 100 : 0;
      // 规则要减到 target，上限要求不超过 cap，取更严的那个
      var want = target;
      if (cfg.sellMode !== "none") want = want === null ? cfg.tqqqCap : Math.min(want, cfg.tqqqCap);
      var cutAmt = 0, kind = null;
      if (tot > 0 && want !== null && share > want + 0.01) {
        cutAmt = vt - tot * want / 100;
        kind = (target !== null && want === target) ? "rule" : "cap";
      }
      hold = {
        total: tot, qqqValue: vq, tqqqValue: vt, tqqqShare: share,
        cap: cfg.tqqqCap, targetShare: want,
        sellAmount: cutAmt, sellShares: pt > 0 ? cutAmt / pt : 0,
        kind: kind, needSell: cutAmt > 1 && cutAmt > tot * 0.005,
      };
    }

    return {
      basedOn: series.dates[i],
      nextDate: next,
      weekdayName: WEEKDAY_CN[(weekdayOf(dayNumber(next)) + 7) % 7],
      frequency: cfg.frequency,
      price: series.adj[i], close: series.close[i], tqqqPrice: series.t[i],
      drawdown: dd[i], dev: hasMA ? tl.dev[i] : null, ma: hasMA ? tl.ma[i] : null,
      // 买
      buy: {
        asset: r.buyTqqq ? "TQQQ" : "QQQ",
        state: r.state, stateLabel: STATE_LABELS[r.state],
        multiplier: r.multiplier, amount: cfg.baseAmount * r.multiplier,
        tqqqAmount: r.buyTqqq ? cfg.baseAmount * r.multiplier * cfg.flowShare / 100 : 0,
      },
      // 离“买 TQQQ”还差多少（两个条件都要满足）
      gap: {
        belowMA: belowMA,
        maGap: hasMA ? tl.dev[i] : null, // >0 表示还要跌这么多百分比才到均线
        deepEnough: deepEnough,
        ddNow: dd[i], ddNeed: cfg.dipThreshold,
        ddGap: Math.max(0, cfg.dipThreshold - dd[i]), // 还要再跌几个点
        ready: belowMA && deepEnough,
      },
      // 卖
      sell: {
        mode: cfg.sellMode, modeName: SELL_NAMES[cfg.sellMode],
        triggered: target !== null,
        targetShare: target,
        note: sellNote,
        peakGap: cfg.sellMode === "peak" ? dd[i] - cfg.sellPeakWithin : null,
      },
      hold: hold,
    };
  }

  // ---------- XIRR ----------
  function xirr(flows, finalValue, finalDay) {
    if (!flows.length || !(finalValue > 0)) return 0;
    function npv(rate) {
      var t = -finalValue;
      for (var i = 0; i < flows.length; i++) t += flows[i][1] * Math.pow(1 + rate, (finalDay - flows[i][0]) / 365);
      return t;
    }
    var lo = -0.99, hi = 5;
    if (npv(lo) * npv(hi) > 0) return 0;
    for (var k = 0; k < 200; k++) {
      var mid = (lo + hi) / 2;
      if (npv(mid) > 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }

  // ---------- 回测 ----------
  // mode: "plainQ" 每次固定金额只买 QQQ | "comboQ" 按倍数只买 QQQ
  //     | "fixed" 每次固定把 fixedShare% 的钱买 TQQQ | "dip" 只在大跌时买 TQQQ
  var FEE = 0.0005; // 换仓的点差 + 手续费假设 0.05%

  // 卖出规则现在要不要减仓、减到多少（返回目标占比 %，null = 不动）
  // 只看 i 这一天（调用方传前一个交易日），不偷看未来
  function sellTargetFor(cfg, dd, tl, i) {
    if (i < 0) return null;
    if (cfg.sellMode === "ma") {
      // 站回均线上方就全卖
      return tl.ok[i] && tl.dev[i] >= 0 ? 0 : null;
    }
    if (cfg.sellMode === "peak") {
      // 离近一年最高点已经不远了，就减到目标比例
      return dd[i] <= cfg.sellPeakWithin ? cfg.sellTargetShare : null;
    }
    return null; // "cap" 和 "none" 不靠择时卖
  }

  function backtest(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var mode = MODE_NAMES[opts.mode] ? opts.mode : "dip";
    var fixedShare = num(opts.fixedShare, 0, 100, 20);
    var n = series.n;
    var dd = (opts.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (opts.tl) || trendLines(series, cfg.maWindow);
    var startIdx = 0;
    if (opts.startDate) while (startIdx < n && series.dates[startIdx] < opts.startDate) startIdx++;
    var endIdx = n;
    if (opts.endDate) { endIdx = 0; while (endIdx < n && series.dates[endIdx] < opts.endDate) endIdx++; }
    if (startIdx < 1) startIdx = 1;
    if (endIdx <= startIdx) return null;

    var isInvestDay = new Uint8Array(n);
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    for (var a = 0; a < days.length; a++) if (days[a] >= startIdx && days[a] < endIdx) isInvestDay[days[a]] = 1;

    var sells = cfg.sellMode === "ma" || cfg.sellMode === "peak";
    var shQ = 0, shT = 0, invested = 0, times = 0, tqqqBuys = 0, rebalances = 0, feePaid = 0, sold = 0;
    var flows = [];
    var curve = [], tshare = [], ratio = [];
    var peak = 0, mdd = 0, mddDate = null;
    var worstRatio = Infinity, worstDate = null;
    var under = 0, maxUnder = 0;

    for (var i = startIdx; i < endIdx; i++) {
      if (isInvestDay[i]) {
        var r = decide(cfg, dd, tl.dev, tl.ok, i - 1);
        var m = mode === "plainQ" ? 1 : r.multiplier;
        var amt = cfg.baseAmount * m;
        invested += amt; times++;
        flows.push([series.day[i], amt]);
        var toT = 0;
        if (mode === "fixed") toT = amt * fixedShare / 100;
        else if (mode === "dip" && r.buyTqqq) toT = amt * cfg.flowShare / 100;
        // ① 先按卖出规则减仓（用前一个交易日的行情判断，不偷看当天）
        var hasT = mode !== "plainQ" && mode !== "comboQ";
        if (hasT && shT > 0 && sells) {
          var want = sellTargetFor(cfg, dd, tl, i - 1); // 想把 TQQQ 降到组合的百分之几；null = 不动
          if (want !== null) {
            var tv0 = shT * series.t[i], tot0 = shQ * series.adj[i] + tv0;
            var keep = tot0 * want / 100;
            if (tot0 > 0 && tv0 > keep + 1e-9) {
              var cut = tv0 - keep;
              shT -= cut / series.t[i];
              feePaid += cut * FEE;
              shQ += cut * (1 - FEE) / series.adj[i];
              sold += cut; rebalances++;
            }
          }
        }
        // ② 再买
        if (toT > 0) { shT += toT / series.t[i]; tqqqBuys++; }
        if (amt - toT > 0) shQ += (amt - toT) / series.adj[i];
        // ③ 买完再守一次上限（"none" 连上限都不守）
        if (hasT && cfg.sellMode !== "none" && cfg.tqqqCap < 100) {
          var tv = shT * series.t[i], tot = shQ * series.adj[i] + tv;
          if (tot > 0 && tv / tot > cfg.tqqqCap / 100) {
            var ex = tv - tot * cfg.tqqqCap / 100;
            shT -= ex / series.t[i];
            feePaid += ex * FEE;
            shQ += ex * (1 - FEE) / series.adj[i];
            sold += ex; rebalances++;
          }
        }
      }
      var vq = shQ * series.adj[i], vt = shT * series.t[i], v = vq + vt;
      curve.push(v);
      tshare.push(v > 0 ? vt / v * 100 : 0);
      ratio.push(invested > 0 ? v / invested : 1);
      if (v > peak) peak = v;
      if (peak > 0) {
        var d0 = v / peak - 1;
        if (d0 < mdd) { mdd = d0; mddDate = series.dates[i]; }
      }
      if (invested > 0) {
        var rr = v / invested;
        if (rr < worstRatio) { worstRatio = rr; worstDate = series.dates[i]; }
        if (v < invested) { under++; if (under > maxUnder) maxUnder = under; } else under = 0;
      }
    }

    var last = endIdx - 1;
    var value = shQ * series.adj[last] + shT * series.t[last];
    return {
      mode: mode,
      modeName: MODE_NAMES[mode],
      startDate: series.dates[startIdx],
      endDate: series.dates[last],
      times: times,
      tqqqBuys: tqqqBuys,
      rebalances: rebalances,
      feePaid: feePaid,
      sold: sold,
      sellMode: cfg.sellMode,
      invested: invested,
      value: value,
      valueQ: shQ * series.adj[last],
      valueT: shT * series.t[last],
      tqqqShare: value > 0 ? shT * series.t[last] / value * 100 : 0,
      profit: value - invested,
      totalReturn: invested > 0 ? value / invested - 1 : 0,
      xirr: xirr(flows, value, series.day[last]),
      maxDrawdown: mdd * 100,
      maxDrawdownDate: mddDate,
      worstRatio: worstRatio === Infinity ? 1 : worstRatio,
      worstRatioDate: worstDate,
      underwaterYears: maxUnder / (cfg.frequency === "daily" ? 252 : 252),
      curve: curve,
      tshare: tshare,
      ratio: ratio, // 市值 ÷ 已投入的钱
      firstIdx: startIdx,
      lastIdx: last,
    };
  }

  // ---------- 稳妥模式：不择时，三层配比，定期再平衡 ----------
  // 三层顺序固定为 [0]=SPY 核心、[1]=QQQ、[2]=TQQQ

  // 这一次的新钱怎么分：先补最缺的那层，补平了再按目标权重分。这样平时不用卖，省成本也省税
  function steadyAlloc(vals, w, amt) {
    var tot = vals[0] + vals[1] + vals[2] + amt;
    var gap = [0, 0, 0], g = 0, k;
    for (k = 0; k < 3; k++) { gap[k] = Math.max(0, w[k] * tot - vals[k]); g += gap[k]; }
    var out = [0, 0, 0];
    if (!(g > 0)) { for (k = 0; k < 3; k++) out[k] = amt * w[k]; return out; }
    var use = Math.min(amt, g);
    for (k = 0; k < 3; k++) out[k] = use * gap[k] / g;
    var left = amt - use;
    if (left > 0) for (k = 0; k < 3; k++) out[k] += left * w[k];
    return out;
  }

  // 真正的再平衡：卖掉超配的，扣掉点差，买回低配的。sh 会被就地改掉
  function steadyRebalance(sh, px, w) {
    var v = [sh[0] * px[0], sh[1] * px[1], sh[2] * px[2]];
    var tot = v[0] + v[1] + v[2];
    if (!(tot > 0)) return { fee: 0, turnover: 0 };
    var sell = 0, need = [0, 0, 0], needSum = 0, k, d;
    for (k = 0; k < 3; k++) {
      d = v[k] - w[k] * tot;
      if (d > 0) { sell += d; sh[k] -= d / px[k]; }
      else { need[k] = -d; needSum += -d; }
    }
    if (!(sell > 0) || !(needSum > 0)) return { fee: 0, turnover: 0 };
    var fee = sell * FEE, cash = sell - fee;
    for (k = 0; k < 3; k++) if (need[k] > 0) sh[k] += cash * (need[k] / needSum) / px[k];
    return { fee: fee, turnover: sell };
  }

  function steadyBacktest(series, config, steady, opts) {
    opts = opts || {};
    if (!series.hasSpy) return null;
    var cfg = withDefaults(config);
    var st = steadyDefaults(steady);
    var w = [st.coreWeight / 100, st.qqqWeight / 100, st.tqqqWeight / 100];
    var n = series.n;
    var startIdx = 0;
    if (opts.startDate) while (startIdx < n && series.dates[startIdx] < opts.startDate) startIdx++;
    var endIdx = n;
    if (opts.endDate) { endIdx = 0; while (endIdx < n && series.dates[endIdx] < opts.endDate) endIdx++; }
    if (startIdx < 1) startIdx = 1;
    if (endIdx <= startIdx) return null;

    var isInvestDay = new Uint8Array(n);
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    for (var a = 0; a < days.length; a++) if (days[a] >= startIdx && days[a] < endIdx) isInvestDay[days[a]] = 1;

    var sh = [0, 0, 0];
    var invested = 0, times = 0, rebalances = 0, feePaid = 0, turnover = 0;
    var flows = [];
    var curve = [], tshare = [], ratio = [], cshare = [];
    var peak = 0, mdd = 0, mddDate = null;
    var worstRatio = Infinity, worstDate = null;
    var under = 0, maxUnder = 0;
    var lastRebYear = null;

    for (var i = startIdx; i < endIdx; i++) {
      var px = [series.spy[i], series.adj[i], series.t[i]];
      if (isInvestDay[i]) {
        var amt = cfg.baseAmount; // 稳妥模式不加码、不减码，每次都一样多
        invested += amt; times++;
        flows.push([series.day[i], amt]);
        var vals = [sh[0] * px[0], sh[1] * px[1], sh[2] * px[2]];
        var buy = steadyAlloc(vals, w, amt);
        for (var k = 0; k < 3; k++) if (buy[k] > 0) sh[k] += buy[k] / px[k];

        var year = series.dates[i].slice(0, 4), doReb = false;
        if (st.rebalance === "yearly") {
          if (lastRebYear === null) lastRebYear = year;
          else if (year !== lastRebYear) { doReb = true; lastRebYear = year; }
        } else if (st.rebalance === "band") {
          var v2 = [sh[0] * px[0], sh[1] * px[1], sh[2] * px[2]];
          var t2 = v2[0] + v2[1] + v2[2];
          if (t2 > 0) for (var m = 0; m < 3; m++) if (Math.abs(v2[m] / t2 - w[m]) * 100 >= st.band) doReb = true;
        }
        if (doReb) {
          var rb = steadyRebalance(sh, px, w);
          if (rb.turnover > 0) { rebalances++; feePaid += rb.fee; turnover += rb.turnover; }
        }
      }
      var vv = [sh[0] * px[0], sh[1] * px[1], sh[2] * px[2]];
      var v = vv[0] + vv[1] + vv[2];
      curve.push(v);
      tshare.push(v > 0 ? vv[2] / v * 100 : 0);
      cshare.push(v > 0 ? vv[0] / v * 100 : 0);
      ratio.push(invested > 0 ? v / invested : 1);
      if (v > peak) peak = v;
      if (peak > 0) { var d0 = v / peak - 1; if (d0 < mdd) { mdd = d0; mddDate = series.dates[i]; } }
      if (invested > 0) {
        var rr = v / invested;
        if (rr < worstRatio) { worstRatio = rr; worstDate = series.dates[i]; }
        if (v < invested) { under++; if (under > maxUnder) maxUnder = under; } else under = 0;
      }
    }

    var last = endIdx - 1;
    var value = sh[0] * series.spy[last] + sh[1] * series.adj[last] + sh[2] * series.t[last];
    return {
      mode: "steady",
      modeName: MODE_NAMES.steady,
      steady: st,
      startDate: series.dates[startIdx],
      endDate: series.dates[last],
      times: times, tqqqBuys: times, rebalances: rebalances,
      feePaid: feePaid, turnover: turnover,
      invested: invested, value: value,
      valueCore: sh[0] * series.spy[last],
      valueQ: sh[1] * series.adj[last],
      valueT: sh[2] * series.t[last],
      coreShare: value > 0 ? sh[0] * series.spy[last] / value * 100 : 0,
      tqqqShare: value > 0 ? sh[2] * series.t[last] / value * 100 : 0,
      profit: value - invested,
      totalReturn: invested > 0 ? value / invested - 1 : 0,
      xirr: xirr(flows, value, series.day[last]),
      maxDrawdown: mdd * 100, maxDrawdownDate: mddDate,
      worstRatio: worstRatio === Infinity ? 1 : worstRatio,
      worstRatioDate: worstDate,
      underwaterYears: maxUnder / 252,
      curve: curve, tshare: tshare, ratio: ratio, cshare: cshare,
      firstIdx: startIdx, lastIdx: last,
    };
  }

  // 这次该往三层各投多少钱（页面上「我的持仓」用）
  function steadyPlan(series, steady, holding, amount) {
    if (!series.hasSpy || !series.n) return null;
    var st = steadyDefaults(steady);
    var i = series.n - 1;
    var w = [st.coreWeight / 100, st.qqqWeight / 100, st.tqqqWeight / 100];
    var px = [series.spy[i], series.adj[i], series.t[i]];
    var h = holding || {};
    var sh = [
      Math.max(0, Number(h.spyShares) || 0),
      Math.max(0, Number(h.qqqShares) || 0),
      Math.max(0, Number(h.tqqqShares) || 0),
    ];
    var vals = [sh[0] * px[0], sh[1] * px[1], sh[2] * px[2]];
    var tot = vals[0] + vals[1] + vals[2];
    var amt = Math.max(0, Number(amount) || 0);
    var buy = steadyAlloc(vals, w, amt);
    var after = [vals[0] + buy[0], vals[1] + buy[1], vals[2] + buy[2]];
    var atot = after[0] + after[1] + after[2];
    var drift = [0, 0, 0], maxDrift = 0, k;
    for (k = 0; k < 3; k++) {
      drift[k] = tot > 0 ? (vals[k] / tot - w[k]) * 100 : 0;
      if (Math.abs(drift[k]) > Math.abs(maxDrift)) maxDrift = drift[k];
    }
    return {
      date: series.dates[i],
      prices: px, values: vals, total: tot,
      buy: buy,
      shares: [px[0] > 0 ? buy[0] / px[0] : 0, px[1] > 0 ? buy[1] / px[1] : 0, px[2] > 0 ? buy[2] / px[2] : 0],
      weightsNow: tot > 0 ? [vals[0] / tot * 100, vals[1] / tot * 100, vals[2] / tot * 100] : [0, 0, 0],
      weightsAfter: atot > 0 ? [after[0] / atot * 100, after[1] / atot * 100, after[2] / atot * 100] : [0, 0, 0],
      targets: [st.coreWeight, st.qqqWeight, st.tqqqWeight],
      drift: drift, maxDrift: maxDrift,
      band: st.band, rebalance: st.rebalance,
      needRebalance: st.rebalance === "band" && tot > 0 ? Math.abs(maxDrift) >= st.band : false,
    };
  }

  // 几种做法一起比
  function compareModes(series, config, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var list = opts.modes || ["plainQ", "comboQ", "fixed", "dip"];
    return list.map(function (m) {
      return backtest(series, config, {
        mode: m, dd: pre.dd, tl: pre.tl,
        startDate: opts.startDate, endDate: opts.endDate, fixedShare: opts.fixedShare,
      });
    }).filter(Boolean);
  }

  // 滚动 N 年：每年 1 月开始，投 N 年
  function rollingWindows(series, config, opts) {
    opts = opts || {};
    var years = Math.round(num(opts.years, 3, 20, 10));
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var first = +series.dates[0].slice(0, 4) + 1;
    var lastYear = +series.dates[series.n - 1].slice(0, 4);
    var modes = opts.modes || ["comboQ", "dip"];
    var out = [];
    for (var y = first; y + years <= lastYear + 1; y++) {
      var row = { year: y, results: {} };
      var okAll = true;
      for (var k = 0; k < modes.length; k++) {
        var r = backtest(series, config, {
          mode: modes[k], dd: pre.dd, tl: pre.tl,
          startDate: y + "-01-01", endDate: (y + years) + "-01-01", fixedShare: opts.fixedShare,
        });
        if (!r) { okAll = false; break; }
        row.results[modes[k]] = r;
      }
      if (okAll) out.push(row);
    }
    return out;
  }

  // 从不同年份开始投到今天
  function compareStarts(series, config, years, opts) {
    opts = opts || {};
    var cfg = withDefaults(config);
    var pre = { dd: drawdowns(series, cfg.basis).dd, tl: trendLines(series, cfg.maWindow) };
    var modes = opts.modes || ["comboQ", "dip"];
    var out = [];
    for (var i = 0; i < years.length; i++) {
      var row = { year: years[i], results: {} };
      var ok = true;
      for (var k = 0; k < modes.length; k++) {
        var r = backtest(series, config, { mode: modes[k], dd: pre.dd, tl: pre.tl, startDate: years[i] + "-01-01", fixedShare: opts.fixedShare });
        if (!r) { ok = false; break; }
        row.results[modes[k]] = r;
      }
      if (ok) out.push(row);
    }
    return out;
  }

  // 历史上买 TQQQ 的时间段（用来在图上画出来）
  function tqqqPeriods(series, config, pre) {
    var cfg = withDefaults(config);
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var out = [], cur = null;
    for (var i = 0; i < series.n; i++) {
      var on = tl.ok[i] && tl.dev[i] < 0 && dd[i] >= cfg.dipThreshold;
      if (on && !cur) cur = { from: series.dates[i], fromIdx: i };
      if (!on && cur) { cur.to = series.dates[i - 1]; cur.toIdx = i - 1; out.push(cur); cur = null; }
    }
    if (cur) { cur.to = series.dates[series.n - 1]; cur.toIdx = series.n - 1; out.push(cur); }
    return out;
  }

  // ---------- 我的持仓：现在 TQQQ 占多少、要不要再平衡 ----------
  function holdingsCheck(series, config, holding) {
    var cfg = withDefaults(config);
    var i = series.n - 1;
    var q = Math.max(0, Number(holding && holding.qqqShares) || 0);
    var t = Math.max(0, Number(holding && holding.tqqqShares) || 0);
    var pq = series.close[i], pt = series.t[i];
    var vq = q * pq, vt = t * pt, tot = vq + vt;
    var share = tot > 0 ? vt / tot * 100 : 0;
    var over = tot > 0 ? Math.max(0, vt - tot * cfg.tqqqCap / 100) : 0;
    return {
      date: series.dates[i], qqqPrice: pq, tqqqPrice: pt,
      qqqValue: vq, tqqqValue: vt, total: tot,
      tqqqShare: share, cap: cfg.tqqqCap,
      overAmount: over, overShares: pt > 0 ? over / pt : 0,
      needRebalance: over > 0.01 * tot && over > 1,
    };
  }

  // ---------- 资金计划：手里的闲钱，每次该投多少 ----------
  function periodMultipliers(series, config, pre) {
    var cfg = withDefaults(config);
    var dd = (pre && pre.dd) || drawdowns(series, cfg.basis).dd;
    var tl = (pre && pre.tl) || trendLines(series, cfg.maWindow);
    var days = investDays(series, cfg.investWeekday, cfg.frequency);
    var out = [];
    for (var i = 0; i < days.length; i++) {
      if (days[i] < 1) continue;
      out.push(decide(cfg, dd, tl.dev, tl.ok, days[i] - 1).multiplier);
    }
    return out;
  }

  // 保守：任何一段开始都不会把钱投光；平均：长期平均刚好投完
  function planBudget(mults, input, nowMultiplier) {
    var perWeek = num(input.perWeek, 1, 10, 1);
    var periods = Math.max(1, Math.round(num(input.weeks, 1, 520, 52) * perWeek));
    var rate = num(input.rate, 0.1, 100, 7);
    var share = num(input.share, 0, 100, 30) / 100;
    var cash = Math.max(0, Number(input.cash) || 0) * share;
    var monthly = Math.max(0, Number(input.monthly) || 0) * share;
    var inflowPer = monthly * 12 / 52 / perWeek; // 每月新增的钱摊到每次定投
    var poolUsd = cash / rate;
    var inflowUsd = inflowPer / rate;
    var worst = 1;
    if (mults && mults.length) {
      for (var s = 0; s + periods <= mults.length; s++) {
        var sum = 0;
        for (var k = 0; k < periods; k++) sum += mults[s + k];
        if (sum / periods > worst) worst = sum / periods;
      }
      if (mults.length < periods) {
        var t = 0;
        for (var j = 0; j < mults.length; j++) t += mults[j];
        worst = Math.max(worst, t / mults.length);
      }
    }
    var avg = 1;
    if (mults && mults.length) {
      var tot = 0;
      for (var m = 0; m < mults.length; m++) tot += mults[m];
      avg = tot / mults.length;
    }
    var baseSafe = (poolUsd / periods + inflowUsd) / worst;
    var baseAvg = (poolUsd / periods + inflowUsd) / avg;
    var mult = num(nowMultiplier, 0, 20, 1);
    return {
      periods: periods, perWeek: perWeek, rate: rate,
      poolUsd: poolUsd, inflowUsd: inflowUsd,
      worstAvgMultiplier: worst, avgMultiplier: avg,
      baseSafe: baseSafe, baseAvg: baseAvg,
      nowSafe: baseSafe * mult, nowAvg: baseAvg * mult,
      baseSafeLocal: baseSafe * rate, baseAvgLocal: baseAvg * rate,
      nowSafeLocal: baseSafe * mult * rate, nowAvgLocal: baseAvg * mult * rate,
    };
  }

  // ---------- 每年数据表 ----------
  function yearly(series, results) {
    var byYear = {}, order = [];
    var idx = results.firstIdx;
    for (var i = idx; i <= results.lastIdx; i++) {
      var y = series.dates[i].slice(0, 4);
      if (!byYear[y]) { byYear[y] = { year: y, endIdx: i, startIdx: i }; order.push(y); }
      byYear[y].endIdx = i;
    }
    return order.map(function (y) {
      var r = byYear[y], k = r.endIdx - idx;
      return {
        year: y,
        value: results.curve[k],
        tqqqShare: results.tshare[k],
        qqq: series.adj[r.endIdx] / series.adj[r.startIdx] - 1,
      };
    });
  }

  return {
    DAY_MS: DAY_MS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    STEADY_DEFAULT: STEADY_DEFAULT,
    REBALANCE_NAMES: REBALANCE_NAMES,
    SELL_MODES: SELL_MODES,
    SELL_NAMES: SELL_NAMES,
    MODE_NAMES: MODE_NAMES,
    STATE_LABELS: STATE_LABELS,
    WEEKDAY_CN: WEEKDAY_CN,
    FEE: FEE,
    dayNumber: dayNumber,
    dateFromDayNumber: dateFromDayNumber,
    weekdayOf: weekdayOf,
    mondayOf: mondayOf,
    withDefaults: withDefaults,
    steadyDefaults: steadyDefaults,
    normalizeTiers: normalizeTiers,
    prepare: prepare,
    drawdowns: drawdowns,
    trendLines: trendLines,
    multiplierFor: multiplierFor,
    decide: decide,
    investDays: investDays,
    nextInvestDate: nextInvestDate,
    currentSignal: currentSignal,
    currentStatus: currentStatus,
    sellTargetFor: sellTargetFor,
    xirr: xirr,
    backtest: backtest,
    steadyAlloc: steadyAlloc,
    steadyRebalance: steadyRebalance,
    steadyBacktest: steadyBacktest,
    steadyPlan: steadyPlan,
    compareModes: compareModes,
    rollingWindows: rollingWindows,
    compareStarts: compareStarts,
    tqqqPeriods: tqqqPeriods,
    holdingsCheck: holdingsCheck,
    periodMultipliers: periodMultipliers,
    planBudget: planBudget,
    yearly: yearly,
  };
});
