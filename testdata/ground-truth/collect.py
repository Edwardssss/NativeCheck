#!/usr/bin/env python3
"""
Ground Truth 汇总：把每个 cell 的真实安装结果 fold 成分层准确率表。

方案 §13.3 —— 分三层统计，不混成一个数字：

  层  | 判定内容             | 指标
  ----+---------------------+---------------------------
  L1  | 是不是 native 包     | 漏报率（权重×2）
  L2  | 走预编译还是源码构建 | FP / FN 率
  L3  | 缺失哪些工具链       | 阻塞项召回率

输入：run-matrix.sh 产出的 out/<cell>/<fixture>/result.properties
      （compiled: yes|no 是编译器 wrapper 的物理事实 —— 编译必经编译器）。

预测来源（env-accurate，首选）：
  predict.sh 在每个 cell 容器内跑 `nativecheck --deep`，把预测写到
  out/<cell>/<fixture>.prediction.json —— 与被测 cell 同一 env（node/libc/工具链）
  生成，因此 L2 预测跟测量严格对齐（宿主机 env ≠ musl cell env 会导致错位）。

  fallback：--predict <file.jsonl>（每行 {fixture, strategy, blockers}，跨 cell 共享）
  仅当 cell 内没产预测文件、又想本地手搓预测时用。

用法：
  python3 testdata/ground-truth/collect.py testdata/ground-truth/out
  python3 testdata/ground-truth/collect.py out --blockers

依赖：仅标准库（properties 用行式 key=value 读，不引 PyYAML）。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys


def read_properties(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def load_prediction_json(path: str) -> dict | None:
    """读 predict.sh 产出的 <fixture>.prediction.json；坏文件视为无预测。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        # 记录产预测的容器 env，便于对照是否为同 env（审计用，不计入指标）
        return data
    except (OSError, ValueError):
        return None


def load_predictions(out_root: str) -> dict[tuple[str, str], dict]:
    """自动发现 out/<cell>/<fixture>.prediction.json，按 (cell, fixture) 键控。"""
    preds: dict[tuple[str, str], dict] = {}
    for cell in sorted(glob.glob(os.path.join(out_root, "*-*"))):
        if not os.path.isdir(cell):
            continue
        cell_name = os.path.basename(cell)
        for pf in glob.glob(os.path.join(cell, "*.prediction.json")):
            row = load_prediction_json(pf)
            if row is None:
                continue
            fixture = row.get("fixture") or os.path.basename(pf)[: -len(".prediction.json")]
            preds[(cell_name, fixture)] = row
    return preds


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("out_root", help="run-matrix.sh 的 out 根目录")
    p.add_argument(
        "--predict",
        help="可选 fallback：跨 cell 共享的 jsonl（每行 {fixture, strategy, blockers}）；"
        "仅在没有 cell 内预测文件时兜底",
    )
    p.add_argument(
        "--blockers",
        action="store_true",
        help="附带 L3 阻塞项统计（需预测含 blockers 计数值，非空=预测有阻塞）",
    )
    args = p.parse_args()

    # fallback jsonl（cell 内无预测文件时兜底）
    fallback: dict[str, dict] = {}
    if args.predict:
        with open(args.predict, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                fallback[row.get("fixture", "")] = row

    cells = sorted(d for d in glob.glob(os.path.join(args.out_root, "*-*")) if os.path.isdir(d))
    if not cells:
        print(f"在 {args.out_root} 未找到任何 cell（*-*）目录。先跑 run-matrix.sh。")
        return 1

    cell_preds = load_predictions(args.out_root)
    print(f"Ground Truth 汇总 —— cells: {len(cells)}，cell 内预测文件: {len(cell_preds)}")

    def pred_for(cell: str, fixture: str) -> dict:
        row = cell_preds.get((cell, fixture)) or fallback.get(fixture, {})
        # 归一化 blockers：predict.sh 记成 int 计数；旧 jsonl 可能是数组。统一成计数。
        b = row.get("blockers")
        if isinstance(b, (list, tuple)):
            row["blockers"] = len(b)
        elif not isinstance(b, (int, float)) or isinstance(b, bool):
            row["blockers"] = None  # 没给 → 不参与 L3
        return row

    grand = {"yes": 0, "no": 0, "failed": 0}
    # L2 聚合四格表；每 (cell, fixture) 一条样本
    tp = fp = fn = tn = 0
    # 预测"不确定"的样本（risk=UNVERIFIED/AMBIGUOUS）：不猜编译/免编，单列，不进四格表。
    l2_undetermined = 0
    l3_predict_block = 0
    l3_with_pred = 0

    for cell in cells:
        name = os.path.basename(cell)
        stat = {"yes": 0, "no": 0, "failed": 0}
        rows: list[tuple[str, str, str, str, str, str, int]] = []
        for res in sorted(glob.glob(os.path.join(cell, "*", "result.properties"))):
            r = read_properties(res)
            fixture = r.get("project", os.path.basename(os.path.dirname(res)))
            compiled = r.get("compiled", "?")
            inst = r.get("install", "?")

            # 安装失败 ≠ 免编译：install-failed 时编译结果不可信（环境失败，非"免编译"证据），
            # 单独成桶，绝不混入 compiled yes/no 分桶，也不进 L2 四格表。
            if inst == "install-failed":
                stat["failed"] += 1
                grand["failed"] += 1
            elif compiled == "yes":
                stat["yes"] += 1
                grand["yes"] += 1
            elif compiled == "no":
                stat["no"] += 1
                grand["no"] += 1
            else:
                stat["failed"] += 1
                grand["failed"] += 1

            pred = pred_for(name, fixture)
            # predict.sh 记录 source: prediction file（env-accurate）；fallback jsonl 标 [fb]
            src_tag = "[fb]" if not cell_preds.get((name, fixture)) else ""
            pred_strategy = pred.get("strategy") or "?"
            pred_risk = pred.get("risk") or "?"
            nb = pred.get("blockers") or 0
            rows.append((fixture, compiled, inst, pred_strategy, pred_risk, src_tag, nb))

            # ---- L2 四格表 ----
            # 预测的"确定性"由 risk 表达（strategy 是乐观默认，risk 才是确定/不确定信号）：
            #   LOW/MEDIUM/HIGH = 确定；UNVERIFIED/AMBIGUOUS = 不确定 → 单列，不进四格表。
            # 故这里只统计 install=ok 且 risk 确定的样本。
            if pred_strategy and pred_strategy != "?" and inst != "install-failed":
                if pred_risk in ("UNVERIFIED", "AMBIGUOUS"):
                    l2_undetermined += 1
                else:
                    actual = compiled == "yes"
                    pred_source = pred_strategy == "SOURCE_BUILD"
                    if pred_source and actual:
                        tp += 1
                    elif pred_source and not actual:
                        fp += 1
                    elif not pred_source and actual:
                        fn += 1
                    else:
                        tn += 1

            # ---- L3 统计：预测本身给了阻塞项计数的样本里，有多少非空 ----
            # （install-failed 恰是阻塞判断的关键信号，保留其参与）
            if pred.get("blockers") is not None:
                l3_with_pred += 1
                if nb > 0:
                    l3_predict_block += 1

        print(f"\n  [{name}] 实际编译 yes={stat['yes']} no={stat['no']} install-fail={stat['failed']}")
        print("      fixture                compiled install  predict(L2)  risk       src  blockers")
        for fixture, compiled, inst, pred_s, pred_risk, src_tag, nb in rows:
            print(f"      {fixture:<24} {compiled:<8} {inst:<7} {pred_s:<12} {pred_risk:<10} {src_tag:<4} {nb}")

    # ---- L2 四格表（跨 cell 聚合）----
    print("\n=== L2 四格表（预测 SOURCE_BUILD × 实际是否编译；仅 install=ok 且 risk 确定）===")
    print(f"  TP(预测编译·真编译)={tp}   FP(预测编译·实免编)={fp}")
    print(f"  FN(预测免编·真编译)={fn}   TN(预测免编·实免编)={tn}")
    print(f"  「不确定」预测(risk=UNVERIFIED/AMBIGUOUS，未计入)={l2_undetermined}")
    denom = tp + fn
    fp_denom = fp + tn
    fn_rate = fn / denom if denom else float("nan")
    fp_rate = fp / fp_denom if fp_denom else float("nan")
    print(f"  L2 FN漏报率={fn_rate:.2%}   L2 FP误报率={fp_rate:.2%}")

    # ---- 方案 E：确定性覆盖率（Fail-Closed 的诚实度量）----
    # 四格表只统计「确定」样本；UNVERIFIED 单列。但「全判 UNVERIFIED」会让 FN/FP 双零、
    # 数字好看却回避了判定 —— 覆盖率把这种回避暴露出来：确定性三态化的前提是
    # 「宁可灰色不可猜错」与「不回避判定」必须同时成立。
    determinate = tp + fp + fn + tn
    install_ok = determinate + l2_undetermined
    coverage = determinate / install_ok if install_ok else float("nan")
    print(f"  确定性覆盖率(determinate/install-ok)={determinate}/{install_ok}={coverage:.1%}")
    print("  （覆盖率过低 = 回避判定；四格表数字须与覆盖率一起读才有意义）")
    if not (tp + fp + fn + tn):
        print("  （无任何带预测的样本 —— 先跑 run-matrix.sh 使其在容器内产出 prediction.json）")
    if args.blockers:
        print(f"\n=== L3 阻塞项统计 ===")
        print(f"  有预测计数的样本: {l3_with_pred}，其中预测含阻塞项: {l3_predict_block}")
        print("  （提示：install=install-failed 且预测含阻塞项 → 阻塞判断可能正确；")
        print("    install 成功却预测含阻塞项 → 阻塞过度，属 FP）")
    else:
        print("\n提示：加 --blockers 看 L3 阻塞项统计。")

    print(f"\n总计 compiled_yes={grand['yes']} compiled_no={grand['no']} install_failed={grand['failed']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
