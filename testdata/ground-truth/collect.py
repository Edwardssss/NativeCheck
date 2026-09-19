#!/usr/bin/env python3
"""
Ground Truth summary: fold each cell's real install results into a layered accuracy table.

Design doc §13.3 -- three separate layers, never collapsed into one number:

  layer | what it decides              | metric
  ------+------------------------------+----------------------------------
  L1    | is it a native package       | miss rate (weight x2)
  L2    | prebuilt or source build     | FP / FN rate
  L3    | which toolchains missing     | blocker recall

Input: out/<cell>/<fixture>/result.properties produced by run-matrix.sh
      (compiled: yes|no is a physical fact from the compiler wrappers -- a build goes through a compiler).

Prediction source (env-accurate, preferred):
  predict.sh runs `nativecheck --deep` inside each cell container and writes the prediction to
  out/<cell>/<fixture>.prediction.json -- generated in the same env (node/libc/toolchain) as the
  measured cell, so the L2 prediction stays strictly aligned with the measurement (a host env
  != musl cell env would drift).

  fallback: --predict <file.jsonl> (one {fixture, strategy, blockers} per line, shared across cells)
  only for when a cell produced no prediction file and you want to hand-roll one locally.

Usage:
  python3 testdata/ground-truth/collect.py testdata/ground-truth/out
  python3 testdata/ground-truth/collect.py out --blockers

Deps: standard library only (properties are read as line-based key=value, no PyYAML).
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
    """Read <fixture>.prediction.json produced by predict.sh; a broken file means no prediction."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        # Record the env of the container that produced it, to check for an env mismatch
        # (auditing only, not a metric)
        return data
    except (OSError, ValueError):
        return None


def load_predictions(out_root: str) -> dict[tuple[str, str], dict]:
    """Auto-discover out/<cell>/<fixture>.prediction.json, keyed by (cell, fixture)."""
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
    p.add_argument("out_root", help="the out root directory produced by run-matrix.sh")
    p.add_argument(
        "--predict",
        help="optional fallback: a jsonl shared across cells ({fixture, strategy, blockers} per line);"
        "used only when a cell has no in-cell prediction file",
    )
    p.add_argument(
        "--blockers",
        action="store_true",
        help="also report L3 blocker statistics (needs a blocker count in the prediction; non-zero = blockers predicted)",
    )
    args = p.parse_args()

    # fallback jsonl (used when a cell has no prediction file)
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
        print(f"no cell (*-*) directory found under {args.out_root}. Run run-matrix.sh first.")
        return 1

    cell_preds = load_predictions(args.out_root)
    print(f"Ground Truth summary -- cells: {len(cells)}, in-cell prediction files: {len(cell_preds)}")

    def pred_for(cell: str, fixture: str) -> dict:
        row = cell_preds.get((cell, fixture)) or fallback.get(fixture, {})
        # Normalize blockers: predict.sh records an int count; an old jsonl may hold an array.
        # Coerce both into a count.
        b = row.get("blockers")
        if isinstance(b, (list, tuple)):
            row["blockers"] = len(b)
        elif not isinstance(b, (int, float)) or isinstance(b, bool):
            row["blockers"] = None  # not given -> excluded from L3
        return row

    grand = {"yes": 0, "no": 0, "failed": 0}
    # L2 aggregate four-square table; one sample per (cell, fixture)
    tp = fp = fn = tn = 0
    # Samples whose prediction is “undetermined” (risk=UNVERIFIED/AMBIGUOUS): do not guess
    # compile/prebuilt, count them separately, and keep them out of the four-square table.
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

            # install-failed != prebuilt: on install-failed the compile result is not trustworthy
            # (an env failure, not evidence of “prebuilt”), so it gets its own bucket and never
            # mixes into the compiled yes/no buckets, nor into the L2 four-square table.
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
            # predict.sh records source: prediction file (env-accurate); the fallback jsonl is tagged [fb]
            src_tag = "[fb]" if not cell_preds.get((name, fixture)) else ""
            pred_strategy = pred.get("strategy") or "?"
            pred_risk = pred.get("risk") or "?"
            nb = pred.get("blockers") or 0
            rows.append((fixture, compiled, inst, pred_strategy, pred_risk, src_tag, nb))

            # ---- L2 four-square table ----
            # A prediction's “certainty” is carried by risk (strategy is the optimistic default;
            #   risk is the determinate/undetermined signal):
            #   LOW/MEDIUM/HIGH = determinate; UNVERIFIED/AMBIGUOUS = undetermined -> counted
            #   separately, kept out of the four-square table.
            # So only install=ok samples with a determinate risk are counted here.
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

            # ---- L3 stats: of the samples whose own prediction gives a blocker count, how many are non-zero ----
            # (install-failed is exactly the key signal for the blocker call, so it still takes part)
            if pred.get("blockers") is not None:
                l3_with_pred += 1
                if nb > 0:
                    l3_predict_block += 1

        print(f"\n  [{name}] actual compile yes={stat['yes']} no={stat['no']} install-fail={stat['failed']}")
        print("      fixture                compiled install  predict(L2)  risk       src  blockers")
        for fixture, compiled, inst, pred_s, pred_risk, src_tag, nb in rows:
            print(f"      {fixture:<24} {compiled:<8} {inst:<7} {pred_s:<12} {pred_risk:<10} {src_tag:<4} {nb}")

    # ---- L2 four-square table (aggregated across cells) ----
    print(
        "\n=== L2 four-square table (predicted SOURCE_BUILD x actually compiled; "
        "install=ok and determinate risk only) ==="
    )
    print(f"  TP(predicted compile / actually compiled)={tp}   FP(predicted compile / actually prebuilt)={fp}")
    print(f"  FN(predicted prebuilt / actually compiled)={fn}   TN(predicted prebuilt / actually prebuilt)={tn}")
    print(f"  undetermined predictions (risk=UNVERIFIED/AMBIGUOUS, excluded)={l2_undetermined}")
    denom = tp + fn
    fp_denom = fp + tn
    fn_rate = fn / denom if denom else float("nan")
    fp_rate = fp / fp_denom if fp_denom else float("nan")
    print(f"  L2 FN miss rate={fn_rate:.2%}   L2 FP false-alarm rate={fp_rate:.2%}")

    # ---- Option E: determinate coverage (an honest measure of fail-closed) ----
    # The four-square table counts only “determinate” samples; UNVERIFIED is separate. But
    # “verdict everything UNVERIFIED” would drive FN/FP to zero -- nice-looking numbers that
    # dodge the decision -- so coverage exposes that dodge: the three-state design only holds
    # if “rather grey than wrong” and “never dodge a verdict” both stand at once.
    determinate = tp + fp + fn + tn
    install_ok = determinate + l2_undetermined
    coverage = determinate / install_ok if install_ok else float("nan")
    print(
        f"  deterministic coverage (determinate/install-ok)="
        f"{determinate}/{install_ok}={coverage:.1%}"
    )
    print(
        "  (low coverage means verdicts are being dodged; the four-square numbers are only"
        " meaningful next to coverage)"
    )
    if not (tp + fp + fn + tn):
        print("  (no sample with a prediction -- run run-matrix.sh so a prediction.json is produced in-cell)")
    if args.blockers:
        print("\n=== L3 blocker statistics ===")
        print(f"  samples with blocker counts: {l3_with_pred}, of which predicted to have blockers: {l3_predict_block}")
        print("  (note: install=install-failed AND predicted blockers -> the blocker call may be right;")
        print("   install succeeded yet blockers predicted -> over-blocking, i.e. FP)")
    else:
        print("\nhint: pass --blockers to see the L3 blocker statistics.")

        print(f"\ntotals compiled_yes={grand['yes']} compiled_no={grand['no']} install_failed={grand['failed']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
