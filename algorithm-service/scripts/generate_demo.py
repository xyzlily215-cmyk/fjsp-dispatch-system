#!/usr/bin/env python3
"""生成 20 订单 x 8 设备的演示实例（固定种子 20260916），输出 demo_instance.json。"""
import json
import os
import random

SEED = 20260916
SIM_START = "2026-09-16T08:00:00+08:00"

FAMILIES = ["轴类A", "盘类B", "壳体C"]

# 工作中心：车削 / 铣削 / 精加工
MACHINE_DEFS = [
    ("M-01", "WC-车削", ["轴类A"]),
    ("M-02", "WC-车削", ["轴类A"]),
    ("M-03", "WC-车削", ["轴类A", "盘类B"]),
    ("M-04", "WC-铣削", ["盘类B", "壳体C"]),
    ("M-05", "WC-铣削", ["盘类B", "壳体C"]),
    ("M-06", "WC-铣削", ["壳体C", "轴类A"]),
    ("M-07", "WC-精加工", ["轴类A", "盘类B", "壳体C"]),
    ("M-08", "WC-精加工", ["轴类A", "盘类B", "壳体C"]),
]

# 每台设备每日两班：08:00-12:00、13:00-17:00，共 5 个工作日
WORK_DAYS = 5


def build_machines(rng):
    machines = []
    for mid, wc, fams in MACHINE_DEFS:
        intervals = []
        for d in range(WORK_DAYS):
            base = d * 1440
            intervals.append([base, base + 240])
            # M-02 第三天下午维修（体现维修合入可用区间）
            if mid == "M-02" and d == 2:
                continue
            intervals.append([base + 300, base + 540])
        machines.append({
            "machineId": mid,
            "workCenterId": wc,
            "productFamilies": fams,
            "availableIntervals": intervals,
        })
    return machines


def build_orders(rng, machines):
    capable = {}
    for fam in FAMILIES:
        capable[fam] = [m["machineId"] for m in machines if fam in m["productFamilies"]]
    orders = []
    for i in range(1, 21):
        oid = "O%03d" % i
        fam = FAMILIES[rng.randrange(len(FAMILIES))]
        n_ops = rng.randint(3, 5)
        quantity = rng.randint(5, 60)
        arrival = 0 if i <= 12 else rng.choice([120, 240, 360, 480])
        priority = rng.choices([1, 2, 3, 4, 5], weights=[2, 3, 5, 3, 2])[0]
        operations = []
        total_min_proc = 0
        for k in range(1, n_ops + 1):
            seq_no = k * 10
            pool = list(capable[fam])
            rng.shuffle(pool)
            n_cand = min(len(pool), rng.randint(1, 3))
            cands = []
            for m in pool[:n_cand]:
                proc = rng.randint(20, 90)
                setup = rng.randint(5, 15)
                cands.append({"machineId": m, "processMinutes": proc,
                              "setupMinutes": setup})
            total_min_proc += min(c["processMinutes"] + c["setupMinutes"] for c in cands)
            operations.append({
                "operationId": "%s-%02d" % (oid, seq_no),
                "seqNo": seq_no,
                "candidates": cands,
            })
        tight = rng.random() < 0.45
        factor = rng.uniform(1.6, 2.2) if tight else rng.uniform(3.0, 4.5)
        due = arrival + int(total_min_proc * factor)
        orders.append({
            "orderId": oid,
            "productFamily": fam,
            "quantity": quantity,
            "arrivalMinutes": arrival,
            "dueMinutes": due,
            "priority": priority,
            "operations": operations,
        })
    return orders


def main():
    rng = random.Random(SEED)
    machines = build_machines(rng)
    orders = build_orders(rng, machines)
    instance = {
        "mode": "BASELINE",
        "simulationStartAt": SIM_START,
        "machines": machines,
        "orders": orders,
        "changeoverDefault": 20,
        "changeoverMatrix": {
            "轴类A|盘类B": 30, "盘类B|轴类A": 30,
            "盘类B|壳体C": 35, "壳体C|盘类B": 35,
            "壳体C|轴类A": 40, "轴类A|壳体C": 40,
        },
        "objectiveWeights": {"makespan": 0.4, "weightedTardiness": 0.4,
                             "loadImbalance": 0.2},
        "algorithm": {"populationSize": 100, "maxGenerations": 300,
                      "timeLimitSeconds": 60, "randomSeed": SEED},
    }
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "demo_instance.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(instance, f, ensure_ascii=False, indent=2)
    n_ops = sum(len(o["operations"]) for o in orders)
    print("written %s (%d orders, %d operations, %d machines)"
          % (os.path.abspath(out), len(orders), n_ops, len(machines)))


if __name__ == "__main__":
    main()
